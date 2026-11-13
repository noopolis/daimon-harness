import path from "node:path";
import { ensureRuntimeHomeDirectory } from "../../runtime/runtimeHomeLayout.js";
import { resolveCodexWakeTimeoutMs, resolveCodexWakeTokenCeiling } from "../../pi/cliSession.js";
import { prepareEngineExecutable } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { recordCodexTurnRequests } from "../../runtime/turnRequestLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { assertNoCodexHomeCredential, requireCodexGateway, verifyCodexGateway } from "./gatewayProvider.js";
import { codexSandboxProtectedPaths, codexSandboxReadablePaths } from "./runtimeSandbox.js";

export const codexRuntimeHooks: RuntimeEngineHooks = {
  runtimeHomeShape: "private",
  hostReadinessOrder: 0,
  async prepareHostReadiness(agents, paths) {
    // The gateway is the sole holder of the login; no realm lease or per-wake copy here.
    requireCodexGateway(agents[0]!.id);
    for (const agent of agents) {
      const canonical = paths.forAgent(agent);
      await canonical.verify();
      await ensureRuntimeHomeDirectory(canonical.runtimeHomePath, ".codex");
      await canonical.verify();
    }
  },
  assertRuntimeLaunch() {},
  async prepareRuntimeReadiness(agent) {
    const gateway = requireCodexGateway(agent.id);
    const executable = await prepareEngineExecutable(agent.id, "codex");
    const engineHomePath = path.join(agent.runtimeHomePath, ".codex");
    const verify = async (): Promise<void> => {
      await executable.verify();
      await assertNoCodexHomeCredential(agent.id, engineHomePath);
      await verifyCodexGateway(agent.id, gateway);
    };
    await verify();
    return { executablePath: executable.executablePath, engineHomePath, verify };
  },
  runtimeSandbox({ agent, readiness, organizationAgents, sharedProtectedPaths }) {
    return agent.engine.codexSandbox === undefined ? {} : { codexSandboxPaths: {
      protectedPaths: codexSandboxProtectedPaths(agent.id, agent, readiness.engineHomePath, organizationAgents ?? [agent], sharedProtectedPaths),
      readablePaths: codexSandboxReadablePaths(agent)
    } };
  },
  runtimeSessionOptions({ agent, engineHomePath, wakeEnvironmentContext, sandbox }) {
    return {
      onTurnUsage: (usage, outcome) => recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", engine: "codex", usage, outcome }),
      onCodexTurnRequests: (threadId) => recordCodexTurnRequests({ agent: agent.id, wake: wakeEnvironmentContext.current ?? "wake", codexHome: engineHomePath, threadId }).then(() => undefined),
      timeoutMs: agent.engine.turnTimeoutMs ?? resolveCodexWakeTimeoutMs(),
      codexTokenCeiling: resolveCodexWakeTokenCeiling(),
      ...(agent.engine.model === undefined ? {} : { model: agent.engine.model }),
      ...(agent.engine.reasoningEffort === undefined ? {} : { reasoningEffort: agent.engine.reasoningEffort }),
      ...(agent.engine.codexSandbox === undefined ? {} : { codexSandbox: agent.engine.codexSandbox }),
      ...(sandbox.codexSandboxPaths === undefined ? {} : {
        codexSandboxProtectedPaths: sandbox.codexSandboxPaths.protectedPaths,
        codexSandboxReadablePaths: sandbox.codexSandboxPaths.readablePaths
      }),
      credentialSecretValues: async () => [requireCodexGateway(agent.id).key]
    };
  },
  runtimeToolName: (name) => name,
  mountedToolNamingRule: bareMountedToolNamingRule,
  runtimeHarnessToolNames: (agent) => agent.engine.codexSandbox === undefined ? undefined : []
};
