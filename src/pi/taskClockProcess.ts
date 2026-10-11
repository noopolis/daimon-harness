import { execFile } from "node:child_process";
import { cliChildEnvironment } from "./cliEnvironment.js";
import { readTaskClock, taskClockPreload, type TaskClock } from "../runtime/taskClock.js";

/** @internal Injection seam for startup tests; never part of runtime configuration. */
export type TaskClockProcessProbe = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<string>;

const dateProbe: TaskClockProcessProbe = (command, args, env) => new Promise((resolve, reject) => {
  execFile(command, [...args], { env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 }, (error, stdout, stderr) => {
    // A loader can ignore a missing library and still exit 0 (even matching a zero offset).
    if (error || stderr.trim()) reject(error ?? new Error("date/libfaketime emitted a startup diagnostic")); else resolve(stdout);
  });
});

/** Run once at agent startup, before any session/wake; deadlines stay on the host clock. */
export async function verifyTaskClockProcess(
  runtimeHomePath: string, clock: TaskClock | undefined = readTaskClock(), probe: TaskClockProcessProbe = dateProbe
): Promise<void> {
  if (clock === undefined) return;
  const refuse = (reason: string): Error => new Error(`NOOPOLIS_TASK_CLOCK: process clock startup probe ${reason}; refusing clocked execution`);
  if (process.platform !== "linux") throw refuse("requires Linux libfaketime interposition");
  const environment = cliChildEnvironment([], runtimeHomePath);
  if (taskClockPreload(environment.LD_PRELOAD) === undefined) throw refuse("requires caller-provided LD_PRELOAD naming libfaketime*.so*");
  // Prove interposition independently: real time must never pass for a near-zero task offset.
  for (const sentinel of [true, false]) {
    const env = sentinel ? { ...environment, FAKETIME: "-31536000" } : environment;
    let output: string;
    try { output = await probe("date", ["-u", "+%s"], env); }
    catch (cause) { throw new Error(refuse("could not run date -u +%s (date/libfaketime missing or unusable)").message, { cause }); }
    const seconds = Number(output.trim());
    const expected = sentinel ? Date.now() - 31_536_000_000 : clock.now();
    if (!/^-?\d+$/u.test(output.trim()) || !Number.isSafeInteger(seconds) || Math.abs(seconds * 1000 - expected) > 5000) {
      throw refuse(`did not observe ${sentinel ? "sentinel offset" : "task time"} within ±5 seconds (check libfaketime and its offset)`);
    }
  }
}
