import { runAgySubscriptionBootstrap } from "./agySubscriptionBootstrap.js";
import { AGY_MAX_TOOL_TURNS, resolveEngineWakeLimitOverrides } from "../../pi/cliSession.js";
import { prepareEngineExecutable, prepareEngineReadiness, verifyAgySubscriptionEnrollment } from "../../runtime/engineReadiness.js";
import { recordTurnUsage, resolveTurnUsageLedgerPath } from "../../runtime/turnUsageLedger.js";
import { bareMountedToolNamingRule, type RuntimeEngineHooks } from "../runtimeHooks.js";
import { startAgySubscriptionRealm } from "./agySubscriptionRealm.js";
import { recordAgyTurnRequests } from "./agyTurnRequests.js";

/** AGY turn wall clock when neither the agent nor `DAIMON_ENGINE_WAKE_TIMEOUT_MS` declares one. */
export const AGY_DEFAULT_TURN_TIMEOUT_MS = 180_000;

export const agyRuntimeHooks: RuntimeEngineHooks = {
  cliCommandKind: "agy-login",
  parseCliArguments(arguments_) {
    if (arguments_.length === 5 && arguments_[0] === "auth" && arguments_[1] === "agy" && arguments_[2] === "login"
      && arguments_[3] === "--config" && arguments_[4]) return { configPath: arguments_[4], kind: "agy-login" };
    return undefined;
  },
  runCliCommand: runAgySubscriptionBootstrap,
  runtimeHomeShape: "private",
  hostReadinessOrder: 2,
  async prepareHostReadiness(agents, paths, resources) {
    const agent = agents[0];
    if (agent === undefined) return;
    const realm = await startAgySubscriptionRealm();
    resources.agyRealm = realm;
    resources.credentialRealms ??= {};
    resources.credentialRealms.agy = realm;
    const canonical = paths.forAgent(agent);
    await canonical.verify();
    const executable = await prepareEngineExecutable(agent.id, "agy");
    await realm.withCredential({ id: agent.id, runtimeHomePath: canonical.runtimeHomePath }, () =>
      verifyAgySubscriptionEnrollment(agent.id, executable.executablePath, canonical.runtimeHomePath, realm.busAddress));
    await executable.verify();
    await canonical.verify();
  },
  assertRuntimeLaunch() {},
  async prepareRuntimeReadiness(agent, bus, _broker, credentialRealm) {
    if (credentialRealm === undefined) return prepareEngineReadiness(agent, agent.runtimeHomePath, bus);
    // Every authentication probe runs in the caller's credential critical section.
    const executable = await prepareEngineExecutable(agent.id, "agy");
    return { executablePath: executable.executablePath, engineHomePath: agent.runtimeHomePath, async verify() {
      await executable.verify();
      await verifyAgySubscriptionEnrollment(agent.id, executable.executablePath, agent.runtimeHomePath, bus);
    } };
  },
  runtimeSandbox: () => ({}),
  runtimeSessionOptions({ agent, agyBusAddress, wakeEnvironmentContext }) {
    return {
      maxToolTurns: AGY_MAX_TOOL_TURNS,
      timeoutMs: agent.engine.turnTimeoutMs ?? resolveEngineWakeLimitOverrides()?.timeoutMs ?? AGY_DEFAULT_TURN_TIMEOUT_MS,
      dbusSessionBusAddress: agyBusAddress,
      onTurnUsage: async (usage, outcome) => {
        const wake = wakeEnvironmentContext.current ?? "wake";
        await recordTurnUsage(resolveTurnUsageLedgerPath(), { agent: agent.id, wake, engine: "agy", usage, outcome });
        if ("requests" in usage && usage.requests !== undefined) await recordAgyTurnRequests({ agent: agent.id, wake, requests: usage.requests });
      }
    };
  },
  runtimeToolName: (name) => name,
  mountedToolNamingRule: bareMountedToolNamingRule,
  runtimeHarnessToolNames: () => undefined
};
