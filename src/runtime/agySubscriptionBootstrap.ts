import { spawn } from "./taskClockProcess.js";

import { cliChildEnvironment } from "../pi/cliEnvironment.js";
import { startAgySubscriptionRealm, type AgySubscriptionRealm } from "./agySubscriptionRealm.js";
import { prepareEngineExecutable, verifyAgySubscriptionEnrollment } from "./engineReadiness.js";
import type { OrganizationRuntimeConfig } from "./organizationRuntime.js";
import { prepareOrganizationRuntimePaths } from "./physicalReadiness.js";

export type AgyBootstrapInvocation = Readonly<{
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>;

export const createAgyBootstrapInvocation = (input: {
  busAddress: string;
  executablePath: string;
  runtimeHomePath: string;
  workspacePath: string;
}): AgyBootstrapInvocation => ({
  args: [],
  command: input.executablePath,
  cwd: input.workspacePath,
  env: {
    ...cliChildEnvironment([], input.runtimeHomePath, {
      dbusSessionBusAddress: input.busAddress,
      engine: "agy",
      engineHomePath: input.runtimeHomePath,
      executablePath: input.executablePath
    }),
    TERM: process.env.TERM ?? "xterm-256color"
  }
});

export async function runAgySubscriptionBootstrap(
  config: OrganizationRuntimeConfig,
  startRealm: () => Promise<AgySubscriptionRealm> = startAgySubscriptionRealm
): Promise<void> {
  const agy = config.agents.find((agent) => agent.engine.kind === "agy");
  if (agy === undefined) throw new Error("AGY bootstrap requires an AGY agent in the runtime config");
  const paths = await prepareOrganizationRuntimePaths(config.agents);
  let realm: AgySubscriptionRealm | undefined;
  let failure: unknown;
  try {
    realm = await startRealm();
    const canonical = paths.forAgent(agy);
    await canonical.verify();
    const executable = await prepareEngineExecutable(agy.id, "agy");
    const invocation = createAgyBootstrapInvocation({
      busAddress: realm.busAddress,
      executablePath: executable.executablePath,
      runtimeHomePath: canonical.runtimeHomePath,
      workspacePath: canonical.workspacePath
    });
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: "inherit"
    });
    const code = await waitForInteractiveChild(child);
    if (code !== 0) throw new Error("AGY interactive subscription enrollment did not complete");
    await executable.verify();
    await verifyAgySubscriptionEnrollment(
      agy.id,
      executable.executablePath,
      canonical.runtimeHomePath,
      realm.busAddress
    );
    await canonical.verify();
  } catch (error) { failure = error; }
  const cleanup = await Promise.allSettled([
    realm?.close(),
    paths.close()
  ].filter((value): value is Promise<void> => value !== undefined));
  const cleanupFailures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (cleanupFailures.length > 0) throw new AggregateError([
    ...(failure === undefined ? [] : [failure]),
    ...cleanupFailures
  ], "AGY bootstrap cleanup failed");
  if (failure !== undefined) throw failure;
}

function waitForInteractiveChild(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal); };
    const onInterrupt = (): void => forward("SIGINT");
    const onTerminate = (): void => forward("SIGTERM");
    const cleanup = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    child.once("error", () => { cleanup(); reject(new Error("AGY interactive subscription enrollment could not start")); });
    child.once("close", (code) => { cleanup(); resolve(code); });
  });
}
