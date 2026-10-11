import { startAgySubscriptionRealm, type AgySubscriptionRealm } from "./agySubscriptionRealm.js";
import { prepareEngineExecutable, verifyAgySubscriptionEnrollment } from "./engineReadiness.js";
import { readTaskClock } from "./taskClock.js";
import { memoryClockOptions } from "../pi/memoryClock.js";
import type { OrganizationRuntimeConfig } from "./organizationRuntime.js";
import { prepareOrganizationRuntimePaths, type OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import { materializePortableCredential } from "./portableCredentialMaterial.js";
import { EngineBrokerControlClient } from "./engineBrokerControlClient.js";

export type OrganizationRuntimeHostReadiness = Readonly<{
  agyRealm?: AgySubscriptionRealm;
  grokBroker?: EngineBrokerControlClient;
  paths: OrganizationRuntimePathAuthority;
  close(): Promise<void>;
}>;

export async function prepareProductionReadiness(
  config: OrganizationRuntimeConfig
): Promise<OrganizationRuntimeHostReadiness> {
  const clock = readTaskClock();
  if (config.agents.some((agent) => agent.memory !== undefined)) memoryClockOptions(clock);
  if (clock !== undefined && config.agents.some((agent) => agent.engine.kind === "grok")) throw new Error("NOOPOLIS_TASK_CLOCK requires task-clock environment support in the native Grok engine broker; this broker does not support it");
  const paths = await prepareOrganizationRuntimePaths(config.agents);
  let realm: AgySubscriptionRealm | undefined;
  let grokBroker: EngineBrokerControlClient | undefined;
  try {
    for (const agent of config.agents) {
      if (agent.engine.kind !== "codex") continue;
      const canonical = paths.forAgent(agent);
      await canonical.verify();
      await materializePortableCredential(agent, canonical.runtimeHomePath);
      await canonical.verify();
    }
    const grokAgents = config.agents.filter((agent): agent is typeof agent & { engine: { kind: "grok" } } => agent.engine.kind === "grok");
    if (grokAgents.length > 0) {
      grokBroker = new EngineBrokerControlClient();
      await grokBroker.ready();
    }
    const agy = config.agents.find((agent) => agent.engine.kind === "agy");
    if (agy !== undefined) {
      realm = await startAgySubscriptionRealm();
      const canonical = paths.forAgent(agy);
      await canonical.verify();
      const executable = await prepareEngineExecutable(agy.id, "agy");
      await verifyAgySubscriptionEnrollment(
        agy.id,
        executable.executablePath,
        canonical.runtimeHomePath,
        realm.busAddress
      );
      await executable.verify();
      await canonical.verify();
    }
    let closed = false;
    return {
      ...(realm === undefined ? {} : { agyRealm: realm }),
      ...(grokBroker === undefined ? {} : { grokBroker }),
      paths,
      async close() {
        if (closed) return;
        closed = true;
        const results = await Promise.allSettled(
          [realm?.close(), paths.close()].filter((value): value is Promise<void> => value !== undefined)
        );
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length > 0) {
          throw new AggregateError(failures, "organization runtime readiness cleanup failed");
        }
      }
    };
  } catch (error) {
    const cleanup = await Promise.allSettled(
      [realm?.close(), paths.close()].filter((value): value is Promise<void> => value !== undefined)
    );
    const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        "organization runtime readiness failed and cleanup was incomplete"
      );
    }
    throw error;
  }
}
