import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn, readyTaskClockEnvironment, type ChildProcess } from "../runtime/taskClockProcess.js";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createPiToolMcpServer } from "../mcp/toolServer.js";
import type { WakeEvent } from "../core/types.js";
import { redactCredentialError, redactCredentialText } from "../core/credentialRedaction.js";
import {
  asGrokAuthenticationRejected,
  classifyGrokAuthenticationDiagnostic,
  GrokSubscriptionAuthenticationRejectedError
} from "../runtime/grokAuthenticationError.js";
import type { TurnUsageOutcome } from "../runtime/turnUsageLedger.js";
import { readChild } from "./cliChildOutput.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import {
  renderCodexArgs,
  spawnEngine
} from "./cliEngineSpawn.js";
import {
  registerCliMcpServer,
  renderAgyMcpAddArgs,
  renderAgyMcpRemoveArgs,
  type CliMcpRegistration
} from "./cliMcpRegistration.js";
import { registerGrokHomeMcpServer } from "./grokHomeMcpRegistration.js";
import { decodeAgyHeadlessTurn, type AgyTurnUsage } from "./agyHeadlessResult.js";
import { type CodexTurnUsage } from "./codexHeadlessResult.js";
import { createCliTurnMeter, decodeCodexTurn, failedTurnOutcome, publishTurnRequests, publishTurnUsage } from "./cliTurnMetering.js";
import { decodeGrokHeadlessResult } from "./grokHeadlessResult.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";
import type { PiSessionLike } from "./piAgentHandle.js";
import type { PiSessionFactoryInput } from "./piHarness.js";
import { ensureRuntimeHome, ensureRuntimeHomeDirectory } from "../runtime/runtimeHomeLayout.js";

export type CliEngineKind = "agy" | "codex" | "grok";

/**
 * The per-wake tool-call bound for AGY, and the one place it is decided.
 *
 * Codex and Grok leave this `undefined` — their only bound is the wake
 * deadline. AGY does not get that treatment, for a measured reason: its
 * terminal usage frame is the *sum* over the turn's model steps, and each tool
 * step resends the whole context. The live capture is 13,796 total tokens for a
 * tool-free turn and 45,381 for a turn with a single call against an
 * empty-schema tool — one call roughly triples the wake. An unbounded loop on
 * the one engine whose subscription quota is currently the operator's only
 * working credential is a cost hazard, not a capability.
 *
 * 16 is chosen so a realistic wake is never truncated (read a few declared MCP
 * tools, then send one or two Moltnet messages) while the worst case is bounded
 * at roughly a quarter-million tokens instead of "whatever fits in 180s". The
 * bound degrades gracefully rather than failing the wake: exceeding it returns
 * `McpToolTurnLimitError` to the model as a tool *error*, so the agent can still
 * finish its turn and reply.
 */
export const AGY_MAX_TOOL_TURNS = 16;

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
  /** Internal production boundary; confirms the custom kernel profile before every Grok process. */
  readonly verifyGrokSandbox?: () => Promise<void>;
  readonly grokSandboxProfile?: string;
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
} & ({
  readonly engine: "codex" | "grok";
} | {
  readonly dbusSessionBusAddress?: string;
  readonly engine: "agy";
});

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

const startMcp = async (
  tools: ToolDefinition[],
  maxToolTurns: number | undefined,
  wakeDeadline: number | undefined,
  onToolsMounted: ((tools: readonly ToolDefinition[]) => void) | undefined,
  onStarted: (mount: { endpoint: string; close: () => Promise<void> }) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> => {
  onToolsMounted?.(tools);
  const mcpServer = createPiToolMcpServer(tools, { maxToolTurns, wakeDeadline });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const httpServer: Server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  let lifecycle: "starting" | "listening" | "closing" | "closed" = "starting";
  let cancelled = false;
  let endpoint = "";
  let closePromise: Promise<void> | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve; });
  const close = (): Promise<void> => closePromise ??= (async () => {
    cancelled = true;
    if (lifecycle !== "closed") lifecycle = "closing";
    // `listen()` begins synchronously but its callback is pending. Waiting for
    // startup prevents dispose from returning while that callback can still bind.
    await startupSettled;
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    // `close` only stops accepting and then waits for every open connection,
    // including the ones the transport has no record of and so cannot end (a
    // socket opened before `initialize`, or a client pool's idle keep-alive
    // socket, which relaying a turn through the broker MCP facade leaves
    // behind). That wait is unbounded and sits on the wake's own completion
    // path: measured, one such connection parked a finished broker turn with
    // its result in hand and published nothing. By here this one wake's engine
    // has returned, failed or been cancelled, so anything still connected is a
    // leftover — see `AGENTS.md`, and the facade, which bounds itself the same
    // way.
    if (httpServer.listening) await new Promise<void>((resolve) => { httpServer.close(() => resolve()); httpServer.closeAllConnections(); });
    lifecycle = "closed";
  })();
  const mount = { get endpoint(): string { return endpoint; }, close };
  onStarted(mount);
  let startupError: unknown;
  try {
    if (cancelled) throw new Error("MCP startup was cancelled");
    await mcpServer.connect(transport);
    if (cancelled) throw new Error("MCP startup was cancelled");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", onError);
        // A disposer can run from a Server.prototype.listen interceptor before
        // this callback. Never publish the server as live in that interleaving.
        if (!cancelled) lifecycle = "listening";
        resolve();
      });
    });
    if (cancelled) throw new Error("MCP startup was cancelled");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("MCP server did not receive an ephemeral port");
    }
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    return mount;
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    settleStartup();
    if (cancelled || startupError !== undefined) await close();
  }
};

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
    readyTaskClockEnvironment(cliChildEnvironment([], this.input.runtimeHomePath));
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
      if (this.options.engine === "grok" && this.options.grokBrokerTurn !== undefined && mount !== undefined) {
        const controller=new AbortController();this.activeBrokerTurn=controller;
        try{output=await this.options.grokBrokerTurn(`${this.options.identityPrompt ?? ""}${text}`,mount.endpoint,controller.signal);}finally{if(this.activeBrokerTurn===controller)this.activeBrokerTurn=undefined;}
      } else {
      if (this.options.engine === "grok" && mount !== undefined) {
        await this.options.verifyExecutable?.();
        registration = await registerGrokHomeMcpServer({
          engineHomePath: this.options.engineHomePath,
          endpoint: mount.endpoint,
          ...(this.options.verifyGrokSandbox !== undefined ? { verify: this.options.verifyGrokSandbox } : {})
        });
        this.mcpRegistration = registration;
      } else if (this.options.engine === "agy" && mount !== undefined) {
        await this.options.verifyExecutable?.();
        registration = await registerCliMcpServer({
          addArgs: renderAgyMcpAddArgs(this.options.commandArgs, mount.endpoint),
          removeArgs: renderAgyMcpRemoveArgs(this.options.commandArgs),
          command: this.options.command ?? this.options.engine,
          cwd: this.input.cwd,
          env: cliChildEnvironment([
            ...(this.options.redactedEnvironmentNames ?? []),
            ...(this.input.daimonSecretEnvironmentNames ?? [])
          ], this.input.runtimeHomePath, {
            ...(this.options.dbusSessionBusAddress !== undefined ? { dbusSessionBusAddress: this.options.dbusSessionBusAddress } : {}),
            engine: this.options.engine,
            executablePath: this.options.command,
            engineHomePath: this.options.engineHomePath
          }),
          onChild: (setupChild) => { this.setupChildren.add(setupChild); },
          onChildSettled: (setupChild) => this.setupChildren.delete(setupChild),
          secretValues
        });
        this.mcpRegistration = registration;
      }
      this.ensureLive();
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      await this.options.verifyGrokSandbox?.();
      child = spawnEngine(this.options, `${this.options.identityPrompt ?? ""}${text}`, this.input, mount?.endpoint, this.wakeId);
      this.activeChild = child;
      // Attach terminal listeners synchronously. A fast local sentinel may
      // exit before an asynchronous post-spawn authority recheck completes.
      const outputPromise = readChild(child, deadline === undefined ? undefined : Math.max(1, deadline - Date.now()), secretValues, {
        failureClassifier: this.options.engine === "grok" ? classifyGrokAuthenticationDiagnostic : undefined,
        retainNdjson: this.options.engine === "codex" ? "codex" : undefined,
        retainStdoutTail: this.options.engine === "grok",
        timeoutErrorMessage: this.options.engine === "codex" && this.options.timeoutMs !== undefined
          ? `Codex wake exceeded its ${this.options.timeoutMs}ms per-wake wall-clock bound`
          : undefined,
        codexTokenCeiling: this.options.engine === "codex" ? this.options.codexTokenCeiling : undefined,
        onCodexTurnCompleted: meter.observeCodexTurnCompleted,
        onCodexThreadStarted: (threadId) => { codexThreadId = threadId; }
      });
      void outputPromise.catch(() => undefined);
      await this.options.verifyRuntimePaths?.();
      await this.options.verifyExecutable?.();
      const childOutput = await outputPromise;
      if (this.options.engine === "grok") output = decodeGrokHeadlessResult(childOutput);
      else if (this.options.engine === "codex") {
        const decoded = decodeCodexTurn(childOutput);
        output = decoded.text;
        turnUsage = decoded.usage;
      }
      else if (this.options.engine === "agy") {
        const decoded = decodeAgyHeadlessTurn(childOutput);
        output = decoded.text;
        turnUsage = decoded.usage;
      } else output = childOutput;
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
      await publishTurnUsage(this.options.onTurnUsage, turnUsage ?? meter.reported(), failedTurnOutcome(failure));
      // A wake that failed still made model requests and still paid for them,
      // so its per-request shape is measured on exactly the paths its spend is.
      await instrument();
    }
    if (promptFailure !== undefined) {
      const authRejection = this.options.engine === "grok" ? asGrokAuthenticationRejected(promptFailure) : undefined;
      if (authRejection !== undefined) throw new GrokSubscriptionAuthenticationRejectedError(
        cleanupFailure === undefined ? undefined : redactCredentialError(cleanupFailure, finalSecrets)
      );
      if (cleanupFailure !== undefined) throw redactCredentialError(cleanupFailure, finalSecrets);
      throw redactCredentialError(promptFailure, finalSecrets);
    }
    if (cleanupFailure !== undefined) {
      if (this.options.engine === "grok" && asGrokAuthenticationRejected(cleanupFailure) !== undefined) {
        throw new GrokSubscriptionAuthenticationRejectedError();
      }
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
