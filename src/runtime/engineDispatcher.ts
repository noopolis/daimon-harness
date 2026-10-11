import { attentionTools, type AttentionRegistry } from "./attention.js";
import { readTaskClock } from "./taskClock.js";
import { memoryClockOptions } from "../pi/memoryClock.js";
import { grokDaimonToolName, grokMountedToolNamingRule } from "../contracts/grokWorkerContract.js";
import path from "node:path";

import type { AgentHandle } from "../core/types.js";
import { AGY_MAX_TOOL_TURNS, createCliSessionFactory, resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling, resolveEngineWakeLimitOverrides } from "../pi/cliSession.js";
import {
  GROK_DAIMON_SANDBOX_PROFILE,
  prepareAndVerifyGrokSandbox
} from "../pi/grokSandbox.js";
import { PiHarnessAdapter } from "../pi/piHarness.js";

import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import { engineAuthFile, engineHomeName, prepareEngineExecutable, prepareEngineReadiness, readPortableEngineCredentialSecrets } from "./engineReadiness.js";
import type { EngineBrokerTurnClient } from "./engineBrokerControlClient.js";
import { createProductionAgentTools } from "./productionAgentTools.js";
import { AGY_SUBSCRIPTION_REALM, GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "./turnUsageLedger.js";
import { recordCodexTurnRequests } from "./turnRequestLedger.js";

/**
 * The production-only bridge from a closed runtime engine intent to Daimon's
 * existing one-agent harness. Configuration never carries a command or env.
 */
export async function startOrganizationRuntimeEngine(
  agent: OrganizationRuntimeAgentConfig,
  controlTokenEnv: string,
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>,
  agyBusAddress?: string,
  grokBroker?: EngineBrokerTurnClient,
  organizationAgents?: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = [],
  attention?: AttentionRegistry
): Promise<AgentHandle> {
  const clock = readTaskClock();
  if (agent.memory !== undefined) memoryClockOptions(clock);
  if (clock !== undefined && agent.engine.kind === "grok" && grokBroker !== undefined) throw new Error("NOOPOLIS_TASK_CLOCK requires task-clock environment support in the native Grok engine broker; this broker does not support it");
  // A declared Grok model is enforced by the broker proxy and worker config;
  // the direct path has neither, so it refuses rather than silently ignoring it.
  if (agent.engine.kind === "grok" && agent.engine.model !== undefined && grokBroker === undefined) throw new Error(`Agent ${agent.id} declares a Grok model, which requires the engine broker`);
  await paths?.verify();
  const canonicalAgent = paths === undefined ? agent : { ...agent, workspacePath: paths.workspacePath, runtimeHomePath: paths.runtimeHomePath };
  const readiness = canonicalAgent.engine.kind === "grok" && grokBroker !== undefined
    ? { ...(await prepareEngineExecutable(canonicalAgent.id, "grok")), engineHomePath: path.join(canonicalAgent.runtimeHomePath, engineHomeName("grok")) }
    : await prepareEngineReadiness(canonicalAgent, canonicalAgent.runtimeHomePath, agyBusAddress);
  const wakeContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {};
  const grokSandbox = canonicalAgent.engine.kind === "grok" && paths !== undefined && organizationAgents !== undefined
    ? () => prepareAndVerifyGrokSandbox({
        command: readiness.executablePath,
        cwd: canonicalAgent.workspacePath,
        engineHomePath: readiness.engineHomePath,
        protectedPaths: grokSandboxProtectedPaths(canonicalAgent.id, organizationAgents, sharedProtectedPaths),
        runtimeHomePath: canonicalAgent.runtimeHomePath
      })
    : undefined;
  const codexSandboxPaths = canonicalAgent.engine.kind === "codex" && canonicalAgent.engine.codexSandbox !== undefined
    ? {
        protectedPaths: codexSandboxProtectedPaths(canonicalAgent.id, canonicalAgent, readiness.engineHomePath, organizationAgents ?? [canonicalAgent], sharedProtectedPaths),
        readablePaths: codexSandboxReadablePaths(canonicalAgent)
      }
    : undefined;
  const mountedTools = [...await createProductionAgentTools(canonicalAgent, wakeContext), ...(agent.attention !== undefined && attention !== undefined ? attentionTools(agent.id, attention) : [])];
  const adapter = adapterFor(canonicalAgent, controlTokenEnv, readiness.verify, readiness.executablePath, readiness.engineHomePath, paths?.verify, agyBusAddress, mountedTools, wakeContext, grokSandbox,grokBroker,codexSandboxPaths, mountedTools.map((tool) => tool.name));
  const handle = await adapter.startAgent({
    id: canonicalAgent.id,
    name: canonicalAgent.name,
    instructions: canonicalAgent.instructions,
    runtimeHomePath: canonicalAgent.runtimeHomePath,
    workspacePath: canonicalAgent.workspacePath
  });
  await paths?.verify();
  const result: AgentHandle = {
    ...handle,
    async wake(event) {
      await paths?.verify();
      await readiness.verify();
      try { return await handle.wake(event); } finally { await paths?.verify(); await readiness.verify(); }
    },
    async stop() { await handle.stop(); },
    status: () => handle.status()
  };
  return result;
}

export function grokSandboxProtectedPaths(
  currentAgentId: string,
  organizationAgents: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): readonly string[] {
  return [
    GROK_SUBSCRIPTION_REALM.bootstrapMountPath,
    GROK_SUBSCRIPTION_REALM.durableMountPath,
    ...(organizationAgents.some((peer) => peer.engine.kind === "agy") ? [
      AGY_SUBSCRIPTION_REALM.unlockMountPath,
      AGY_SUBSCRIPTION_REALM.durableMountPath
    ] : []),
    ...sharedProtectedPaths,
    ...organizationAgents.filter((peer) => peer.id !== currentAgentId)
      .flatMap((peer) => [peer.runtimeHomePath, peer.workspacePath])
  ];
}

export function codexSandboxProtectedPaths(
  currentAgentId: string,
  currentAgent: OrganizationRuntimeAgentConfig,
  currentEngineHomePath: string,
  organizationAgents: readonly OrganizationRuntimeAgentConfig[],
  sharedProtectedPaths: readonly string[] = []
): readonly string[] {
  return [...new Set([
    engineAuthFile("codex", currentEngineHomePath),
    path.join(currentAgent.runtimeHomePath, ".daimon-inbound"),
    "/proc",
    "/run",
    ...grokSandboxProtectedPaths(currentAgentId, organizationAgents, sharedProtectedPaths)
  ])];
}

export function codexSandboxReadablePaths(
  currentAgent: OrganizationRuntimeAgentConfig
): readonly string[] {
  return [path.join(currentAgent.runtimeHomePath, "tool-output")];
}

function adapterFor(agent: OrganizationRuntimeAgentConfig, controlTokenEnv: string, verifyExecutable: () => Promise<void>, executablePath: string, engineHomePath: string, verifyRuntimePaths?: () => Promise<void>, agyBusAddress?: string, productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[] = [], wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef = {}, verifyGrokSandbox?: () => Promise<void>,grokBroker?:EngineBrokerTurnClient,codexSandboxPaths?: { readonly protectedPaths: readonly string[]; readonly readablePaths: readonly string[] }, mountedToolNames: readonly string[] = []): PiHarnessAdapter {
  const engine = agent.engine.kind;
  const sessionFactory = createCliSessionFactory(
    engine === "agy"
      ? { engine, maxToolTurns: AGY_MAX_TOOL_TURNS, timeoutMs: 180_000, dbusSessionBusAddress: agyBusAddress, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent, mountedToolNames), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths,
        // AGY has no broker to meter it, so the session hands its decoded
        // terminal-frame usage straight to the same ledger the Grok broker
        // appends to. `recordTurnUsage` is advisory and never rejects.
        onTurnUsage: (usage, outcome) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "agy", usage, outcome }) }
      : { engine, redactedEnvironmentNames: [controlTokenEnv], identityPrompt: identityEnvelope(agent, mountedToolNames), command: executablePath, engineHomePath, verifyExecutable, verifyRuntimePaths,
        ...(engine === "codex" ? {
          // Codex has no broker to meter it, so publish terminal-frame usage
          // to the shared advisory ledger — on the wake that published and on
          // the wake that failed after Codex had already reported its spend.
          onTurnUsage: (usage: import("../pi/codexHeadlessResult.js").CodexTurnUsage, outcome: import("./turnUsageLedger.js").TurnUsageOutcome) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "codex", usage, outcome }),
          // Per-model-request accounting, written to its own stream beside the
          // ledger. `engineHomePath` is the agent's `CODEX_HOME`
          // (`../pi/cliEnvironment.ts`), so the rollout Codex just wrote for
          // this thread is under it. Advisory throughout: it never fails a wake.
          onCodexTurnRequests: (threadId: string) => recordCodexTurnRequests({ agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", codexHome: engineHomePath, threadId }).then(() => undefined),
          // `maxToolTurns` mediates only daimon-MCP tool calls; Codex's own
          // shell is never routed through it, so it gets its own wall-clock
          // and per-wake token bounds instead (`cliSession.ts`).
          timeoutMs: resolveCodexWakeTimeoutMs(),
          codexTokenCeiling: resolveCodexWakeTokenCeiling(),
          // Present only when the parsed config declared them; absent keeps
          // today's unpinned Codex CLI default and today's exact argv.
          ...(agent.engine.model === undefined ? {} : { model: agent.engine.model }),
          ...(agent.engine.reasoningEffort === undefined ? {} : { reasoningEffort: agent.engine.reasoningEffort }),
          ...(agent.engine.codexSandbox === undefined ? {} : { codexSandbox: agent.engine.codexSandbox }),
          ...(codexSandboxPaths === undefined ? {} : {
            codexSandboxProtectedPaths: codexSandboxPaths.protectedPaths,
            codexSandboxReadablePaths: codexSandboxPaths.readablePaths
          })
        } : {}),
        ...(engine==="grok"&&grokBroker!==undefined?{}:{credentialSecretValues: () => readPortableEngineCredentialSecrets(agent.id, engine, engineHomePath)}),
        // The broker seals usage and enforces its registration's limits; the
        // wake may only lower them (DAIMON_ENGINE_WAKE_*), and a declared model
        // must be the one the broker reports it ran.
        ...(engine==="grok"&&grokBroker!==undefined?{grokBrokerTurn:grokBrokerTurnFor(agent,grokBroker,wakeEnvironmentContext)}:{}),
        ...(engine === "grok" && verifyGrokSandbox ? {
          grokSandboxProfile: GROK_DAIMON_SANDBOX_PROFILE,
          verifyGrokSandbox
        } : {}) }
  );
  return cliHarness(agent, sessionFactory, [controlTokenEnv], productionTools, wakeEnvironmentContext);
}

function grokBrokerTurnFor(agent: OrganizationRuntimeAgentConfig, grokBroker: EngineBrokerTurnClient, wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef) {
  const limits = resolveEngineWakeLimitOverrides();
  const options = { ...(limits === undefined ? {} : { limits }), ...(agent.engine.model === undefined ? {} : { model: agent.engine.model }) };
  return (prompt: string, endpoint: string, signal: AbortSignal) => grokBroker.turn(agent.id, wakeEnvironmentContext.current ?? "wake", prompt, endpoint, signal, options);
}

/**
 * CLI engines do not consume Pi's resource loader. Frame the same immutable
 * identity in JSON so arbitrary names/instructions cannot change its shape.
 */
/**
 * The caller-owned prompt preamble.
 *
 * It names the mounted tools explicitly, because a CLI engine reaches Daimon's
 * tools over MCP and an agent whose instructions name another engine's tool
 * spelling can finish a turn having called nothing. The declared names are the
 * caller's own configuration, not engine-supplied text.
 *
 * On Grok the bare names are not the callable ones: every Daimon tool is a
 * deferred MCP tool of server `daimon`, and Grok 1.0.34 refuses an unqualified
 * name before any HTTP ("Tool names must be qualified as `server__tool`"). This
 * envelope used to instruct exactly that refused form. The correct rule is not
 * restated here — it is rendered by `grokMountedToolNamingRule` in the same
 * contract module that renders the worker's pinned system prompt, so the two
 * texts cannot contradict each other again. Every other engine's sentence is
 * unchanged, byte for byte.
 */
export function identityEnvelope(agent: OrganizationRuntimeAgentConfig, mountedToolNames: readonly string[] = []): string {
  return [
    "<daimon-agent-identity>",
    JSON.stringify({ id: agent.id, name: agent.name, instructions: agent.instructions }),
    "</daimon-agent-identity>",
    ...(mountedToolNames.length === 0 ? [] : [
      (agent.engine.kind === "grok"
        ? grokMountedToolNamingRule(mountedToolNames)
        : `Your mounted tools are exactly: ${mountedToolNames.join(", ")}. Call them by these names; `
          + "your instructions may spell them differently.")
        + " No other tool reaches the newsroom."
    ]),
    // The one tool that reaches colleagues is named the way this engine can
    // call it. Meaning and prohibition are unchanged; only the spelling is.
    `Colleagues only hear you when you call ${engineToolName(agent, "moltnet_send")}; your terminal response is a private note to the runtime, not a message to anyone — keep it to one line or leave it empty. `
      + "Do not seek transport credentials or invoke a transport CLI unless the caller explicitly mounted an authenticated transport tool.",
    "The following is the current wake event."
  ].join("\n") + "\n";
}

/**
 * One Daimon tool name, spelled the way this agent's engine accepts it.
 *
 * On Grok the bare form is refused as an invalid MCP tool name, so any
 * engine-facing sentence that *names* a tool renders it through the contract's
 * `grokDaimonToolName`; every other engine keeps the bare name byte for byte.
 * Grok's own native tools (`read_file`, `search_tool`, `use_tool`) are not
 * Daimon tools and never take the prefix.
 */
const engineToolName = (agent: OrganizationRuntimeAgentConfig, tool: string): string =>
  agent.engine.kind === "grok" ? grokDaimonToolName(tool) : tool;

function cliHarness(
  agent: OrganizationRuntimeAgentConfig,
  sessionFactory: ReturnType<typeof createCliSessionFactory>,
  protectedEnvironmentNames: readonly string[], productionTools: readonly import("@earendil-works/pi-coding-agent").ToolDefinition[], wakeEnvironmentContext: import("../pi/piAgentWakeSupport.js").PiWakeEnvironmentContextRef
): PiHarnessAdapter {
  return new PiHarnessAdapter({
    authPath: path.join(agent.runtimeHomePath, "auth.json"),
    // Pi owns the harness envelope while the session factory owns this CLI.
    model: {
      auth: { method: "none" },
      endpoint: { baseUrl: "http://127.0.0.1/daimon-cli", compatibility: "openai" },
      name: "daimon-cli",
      provider: "daimon-cli"
    },
    sessionFactory,
    protectedEnvironmentNames,
    productionTools,
    ...(agent.engine.kind === "codex" && agent.engine.codexSandbox !== undefined ? { toolNames: [] } : {}),
    wakeEnvironmentContext,
    ...(agent.memory === undefined ? {} : { memory: {
      runtimeHomePath: agent.memory.runtimeHomePath,
      ...(agent.memory.source === undefined ? {} : { source: agent.memory.source }),
      ...(agent.memory.tokenBudget === undefined ? {} : { tokenBudget: agent.memory.tokenBudget })
    } })
  });
}
