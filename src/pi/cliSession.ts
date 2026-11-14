import { startMcp } from "./cliSessionMcp.js";
import type { ChildProcess } from "node:child_process";
import { reportEngineTaskClockGap } from "./engineTaskClock.js";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { WakeEvent } from "../core/types.js";
import { redactCredentialError, redactCredentialText } from "../core/credentialRedaction.js";
import type { TurnUsageOutcome } from "../runtime/turnUsageLedger.js";
import { readChild } from "./cliChildOutput.js";
import { createCliStderrLog } from "./cliStderrLog.js";
import { spawnEngine } from "./cliEngineSpawn.js";
import type { CliMcpRegistration } from "./cliMcpRegistration.js";
import { type AgyTurnUsage } from "../engines/agy/agyHeadlessResult.js";
import { type CodexTurnUsage } from "../engines/codex/codexHeadlessResult.js";
import { createCliTurnMeter, failedTurnOutcome, publishTurnRequests, publishTurnUsage } from "./cliTurnMetering.js";
import { getEngineHandler } from "../engines/registry.js";
import type { EngineKind } from "../engines/descriptors.js";
import type { EngineCliIdentity } from "../engines/piHooks.js";
import { terminateChild } from "./cliProcess.js";
import type { PiSessionLike } from "./piAgentHandle.js";
import type { PiSessionFactoryInput } from "./piHarness.js";
import { ensureRuntimeHome, ensureRuntimeHomeDirectory } from "../runtime/runtimeHomeLayout.js";

export type CliEngineKind = EngineKind;

export { AGY_MAX_TOOL_TURNS } from "../engines/agy/piHooks.js";

export {
  DAIMON_CODEX_WAKE_TIMEOUT_MS_ENV, DAIMON_CODEX_WAKE_TOKEN_CEILING_ENV, DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV, DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV,
  DEFAULT_CODEX_WAKE_TIMEOUT_MS, DEFAULT_CODEX_WAKE_TOKEN_CEILING, resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling, resolveEngineWakeLimitOverrides
} from "./engineWakeLimits.js";

export type CliEngineOptions = {
  readonly commandArgs?: readonly string[];
  readonly command?: string;
  /** Internal production authority: rechecked immediately before each child. */
  readonly verifyExecutable?: () => Promise<void>;
  readonly verifyRuntimePaths?: () => Promise<void>;
  readonly engineHomePath?: string;
  readonly maxToolTurns?: number;
  readonly onToolsMounted?: (tools: readonly ToolDefinition[]) => void;
  readonly timeoutMs?: number;
  /** Daimon-owned identity envelope prepended exactly once to every wake. */
  readonly identityPrompt?: string;
  readonly redactedEnvironmentNames?: readonly string[];
  /** Internal secret-file authority used only for exact reply redaction. */
  readonly credentialSecretValues?: () => Promise<readonly string[]>;
  readonly grokBrokerTurn?: (prompt: string, mcpEndpoint: string, signal: AbortSignal) => Promise<string>;
  /** Codex only: kills the child and fails the wake once a turn's own reported usage reaches this. */
  readonly codexTokenCeiling?: number;
  /** Codex only: pinned model name, rendered as `--model=<value>`. Omitted, Codex resolves its own default. */
  readonly model?: string;
  /** Codex only: pinned `model_reasoning_effort`, rendered as `-c model_reasoning_effort=<value>`. */
  readonly reasoningEffort?: string;
  readonly codexSandbox?: { readonly mode: "workspace-write"; readonly networkAccess: false; readonly webSearch: "disabled" };
  /** Internal production boundary: absolute host paths denied to Codex model-run local commands. */
  readonly codexSandboxProtectedPaths?: readonly string[];
  /** Internal production boundary: own non-secret runtime paths a strict Codex turn may read. */
  readonly codexSandboxReadablePaths?: readonly string[];
  /** Strict isolated trials may disable native ambient AGENTS.md discovery. */
  readonly codexProjectDocMaxBytes?: 0;
  /**
   * Advisory per-turn metering sink for the engines whose headless stream
   * reports token usage and that do not run behind the Grok engine broker
   * (which meters its own turns). It never fails a turn that published.
   *
   * `outcome` says whether the wake this usage belongs to went on to succeed.
   * A failed wake spends real money, so it is metered exactly like a
   * successful one and the reader tells them apart by this field rather than
   * by the row's absence.
   */
  readonly onTurnUsage?: (usage: AgyTurnUsage | CodexTurnUsage, outcome: TurnUsageOutcome) => Promise<void>;
  /**
   * Codex only: advisory per-model-request instrumentation, called once per
   * wake with the thread id Codex announced on `thread.started`.
   *
   * The usage ledger's row is one sum per wake and cannot distinguish a cold
   * prefix replayed per request from a context that grows per request. The
   * per-request detail exists in the rollout Codex already writes for this
   * thread; the thread id is the only thing that identifies *which* rollout,
   * which is why it is carried out of the stream rather than inferred from
   * whichever file on disk is newest. Errors here never reach the wake.
   */
  readonly onCodexTurnRequests?: (threadId: string) => Promise<void>;
} & EngineCliIdentity;

export type CliSessionInput = {
  readonly cwd: string;
  readonly customTools?: ToolDefinition[];
  readonly daimonSecretEnvironmentNames?: readonly string[];
  readonly runtimeHomePath?: string;
};

type SessionEvent = Parameters<PiSessionLike["subscribe"]>[0] extends (event: infer Event) => void ? Event : never;
type CliListener = Parameters<PiSessionLike["subscribe"]>[0];
type CliTurnEnd = Extract<SessionEvent, { type: "turn_end" }>;


export const prepareCliRuntimeHome = async (runtimeHomePath: string | undefined): Promise<void> => {
  if (runtimeHomePath === undefined) return;
  await ensureRuntimeHome(runtimeHomePath);
  await Promise.all([".config", ".local/share", ".local/state", ".cache", ".tmp"]
    .map((relative) => ensureRuntimeHomeDirectory(runtimeHomePath, relative)));
};

const childSecretValues = (redactedNames: readonly string[]): readonly string[] =>
  redactedNames
    .map((name) => process.env[name])
    .filter((value): value is string => typeof value === "string" && value.length > 0);

const captureCleanup = async (current: unknown, action: () => Promise<void>): Promise<unknown> => {
  try { await action(); } catch (error) { return current ?? error; }
  return current;
};

export { terminateChild } from "./cliProcess.js";
export { CLI_ENGINE_MAX_DIAGNOSTIC_BYTES, CLI_ENGINE_MAX_OUTPUT_BYTES, readChild } from "./cliChildOutput.js";


class CliSession implements PiSessionLike {
  private readonly listeners = new Set<CliListener>();
  private readonly setupChildren = new Set<ChildProcess>();
  private disposed = false;
  private activeChild: ChildProcess | undefined;
  private activeMount: { close: () => Promise<void> } | undefined;
  private activeBrokerTurn: AbortController | undefined;
  private mcpRegistration: CliMcpRegistration | undefined;
  private disposePromise: Promise<void> | undefined;
  private wakeId: string | undefined;

  public constructor(
    private readonly options: CliEngineOptions,
    private readonly input: CliSessionInput
  ) {}

  public subscribe(listener: CliListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public bindWake(event?: WakeEvent): void {
    this.wakeId = event?.id;
  }

  public async prompt(text: string): Promise<void> {
    if (this.disposed) throw new Error("CLI session is disposed");
    const handler = getEngineHandler(this.options.engine);
    reportEngineTaskClockGap(this.options.engine);
    await prepareCliRuntimeHome(this.input.runtimeHomePath);
    const deadline = this.options.timeoutMs === undefined ? undefined : Date.now() + this.options.timeoutMs;
    const environmentSecretValues = childSecretValues([
      ...(this.options.redactedEnvironmentNames ?? []),
      ...(this.input.daimonSecretEnvironmentNames ?? [])
    ]);
    const stagedCredentialSecrets = await this.options.credentialSecretValues?.() ?? [];
    const secretValues = [...environmentSecretValues, ...stagedCredentialSecrets];
    let mount: { endpoint: string; close: () => Promise<void> } | undefined;
    let registration: CliMcpRegistration | undefined;
    let turnUsage: AgyTurnUsage | CodexTurnUsage | undefined;
    // Kept beside the decoded turn so a wake that never reaches its decoder
    // still owes the ledger the usage Codex already reported (`cliTurnMetering.ts`).
    const meter = createCliTurnMeter();
    // AGY reports usage only on its terminal frame; its meter keeps the finished steps a killed turn already paid for.
    const engineMeter = handler.createTurnMeter?.();
    // Codex's own `thread.started` frame, carried out of the stream so the
    // wake's rollout can be found by identity rather than by recency.
    let codexThreadId: string | undefined;
    let instrumented = false;
    const instrument = async (): Promise<void> => {
      if (instrumented) return;
      instrumented = true;
      await publishTurnRequests(this.options.onCodexTurnRequests, codexThreadId);
    };
    let child: ChildProcess | undefined;
    let output: string | undefined;
    let cleanupFailure: unknown;
    let promptFailure: unknown;
    try {
      // Every CLI engine mounts the same tool surface. AGY used to be the one
      // exception (`toolAccess: "none"`), which is exactly what made an AGY
      // agent unable to reach Moltnet or a declared MCP server, and so unable
      // to take part in an organization at all.
      mount = await startMcp(this.input.customTools ?? [], this.options.maxToolTurns, deadline, this.options.onToolsMounted, (started) => {
        this.activeMount = started;
        if (this.disposed) void started.close();
      });
      this.ensureLive();
      const brokerTurn = handler.brokerTurn(this.options);
      if (brokerTurn !== undefined && mount !== undefined) {
        const controller=new AbortController();this.activeBrokerTurn=controller;
        try{output=await brokerTurn(`${this.options.identityPrompt ?? ""}${text}`,mount.endpoint,controller.signal);}finally{if(this.activeBrokerTurn===controller)this.activeBrokerTurn=undefined;}
      } else {
      if (mount !== undefined) {
        registration = await handler.registerMcp({ options: this.options, input: this.input, endpoint: mount.endpoint,
          onChild: (setupChild) => { this.setupChildren.add(setupChild); },
          onChildSettled: (setupChild) => this.setupChildren.delete(setupChild), secretValues });
        this.mcpRegistration = registration;
      }
      this.ensureLive();
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      child = spawnEngine(this.options, `${this.options.identityPrompt ?? ""}${text}`, this.input, mount?.endpoint, this.wakeId);
      this.activeChild = child;
      // Attach terminal listeners synchronously. A fast local sentinel may
      // exit before an asynchronous post-spawn authority recheck completes.
      // The engine's whole stderr goes to the runtime's own log; a failure's error carries only an excerpt.
      const stderrLog = createCliStderrLog(`engine=${this.options.engine} wake=${this.wakeId ?? "none"}`, secretValues);
      const outputPromise = readChild(child, deadline === undefined ? undefined : Math.max(1, deadline - Date.now()), secretValues, {
        ...handler.childReadOptions(this.options),
        onStderrData: stderrLog.observe,
        onCodexTurnCompleted: meter.observeCodexTurnCompleted,
        ...(engineMeter === undefined ? {} : { onStdoutData: engineMeter.observe }),
        onCodexThreadStarted: (threadId) => { codexThreadId = threadId; }
      });
      void outputPromise.then(stderrLog.finish, stderrLog.finish);
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      const childOutput = await outputPromise;
      const decoded = handler.decodeOutput(childOutput);
      output = decoded.text;
      turnUsage = decoded.usage;
      }
    } catch (error) {
      promptFailure = error;
    } finally {
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { if (child !== undefined) await terminateChild(child); });
      if (this.activeChild === child) this.activeChild = undefined;
      let registrationClosed = registration === undefined;
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { await registration?.close(); registrationClosed = true; });
      if (registrationClosed && this.mcpRegistration === registration) this.mcpRegistration = undefined;
      cleanupFailure = await captureCleanup(cleanupFailure, async () => { await mount?.close(); });
      if (this.activeMount === mount) this.activeMount = undefined;
    }
    const refreshedCredentialSecrets = await this.options.credentialSecretValues?.().catch(() => []) ?? [];
    const finalSecrets = [...secretValues, ...refreshedCredentialSecrets];
    // A wake that Codex reported usage for is metered whether or not it goes on
    // to publish. Every throw below this point used to drop that spend on the
    // floor, so a breached ceiling, an expired wall clock, a non-zero exit, or
    // a turn judged unpublishable all cost money the ledger never saw.
    const failure = promptFailure ?? cleanupFailure;
    if (failure !== undefined) {
      await publishTurnUsage(this.options.onTurnUsage, turnUsage ?? meter.reported() ?? engineMeter?.reported(), failedTurnOutcome(failure));
      // A wake that failed still made model requests and still paid for them,
      // so its per-request shape is measured on exactly the paths its spend is.
      await instrument();
    }
    if (promptFailure !== undefined) {
      const authRejection = handler.authenticationError(promptFailure,
        cleanupFailure === undefined ? undefined : redactCredentialError(cleanupFailure, finalSecrets));
      if (authRejection !== undefined) throw authRejection;
      if (cleanupFailure !== undefined) throw redactCredentialError(cleanupFailure, finalSecrets);
      throw redactCredentialError(promptFailure, finalSecrets);
    }
    if (cleanupFailure !== undefined) {
      const authRejection = handler.authenticationError(cleanupFailure);
      if (authRejection !== undefined) throw authRejection;
      throw redactCredentialError(cleanupFailure, finalSecrets);
    }
    if (output === undefined) return;
    output = redactCredentialText(output, finalSecrets, 64 * 1024);
    for (const listener of this.listeners) listener({
      type: "turn_end",
      message: {
        role: "assistant", content: [{ type: "text", text: output }], api: "openai-completions", provider: "openai", model: "cli",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now()
      }, toolResults: []
    } satisfies CliTurnEnd);
    // Meter only after the turn has published.
    await publishTurnUsage(this.options.onTurnUsage, turnUsage ?? meter.reported(), { status: "completed" });
    await instrument();
  }

  public dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.disposePromise ??= this.quiesce();
  }

  public async disposeAsync(): Promise<void> {
    this.dispose();
    await this.disposePromise;
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error("CLI session is disposed");
  }

  private async quiesce(): Promise<void> {
    let cleanupFailure: unknown;
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { if (this.activeChild !== undefined) await terminateChild(this.activeChild); });
    this.activeBrokerTurn?.abort();
    cleanupFailure = await captureCleanup(cleanupFailure, () => Promise.all([...this.setupChildren].map((child) => terminateChild(child))).then(() => undefined));
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { await this.mcpRegistration?.close(); });
    cleanupFailure = await captureCleanup(cleanupFailure, async () => { await this.activeMount?.close(); });
    if (cleanupFailure !== undefined) throw cleanupFailure;
  }
}

export const createCliSessionFactory = (options: CliEngineOptions) => async (
  input: PiSessionFactoryInput
): Promise<{ session: PiSessionLike }> => {
  if (input.cwd === undefined) throw new Error("CLI session cwd is required");
  return {
    session: new CliSession(options, {
      cwd: input.cwd,
      customTools: input.customTools,
      daimonSecretEnvironmentNames: input.daimonSecretEnvironmentNames,
      runtimeHomePath: input.runtimeHomePath
    })
  };
};

export { runEngine, runEngineDetailed, type EngineRunResult } from "./cliEngineRun.js";
export { renderAgyArgs, renderCodexArgs, spawnEngine } from "./cliEngineSpawn.js";
