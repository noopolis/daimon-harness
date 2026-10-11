import childProcess, { type SpawnOptions } from "node:child_process";
import { readTaskClock, realTimeProcessEnvironment, taskClockChildEnvironment, taskClockProcessEnvironment, type TaskClock } from "./taskClock.js";

export type { ChildProcess } from "node:child_process";
/** @internal Synchronous injection seam; never runtime configuration. */
export type TaskClockProcessProbe = (command: string, args: readonly string[], environment: NodeJS.ProcessEnv) => string;

const verified = new Set<string>();
/** @internal Isolate simulated probes between tests. */
export function resetTaskClockProcessForTest(): void { verified.clear(); }

const dateProbe: TaskClockProcessProbe = (command, args, env) => {
  const result = childProcess.spawnSync(command, [...args], { env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 });
  // Loaders can ignore a missing library and still exit zero, including at zero offset.
  if (result.error || result.status !== 0 || result.stderr?.trim()) throw result.error ?? new Error("date/libfaketime emitted a startup diagnostic");
  return result.stdout;
};

/** Shared child-launch boundary, including SDK transports and Pi's spawn hook.
 * Keep the synchronous spawn API: only the first launch blocks for the bounded probes.
 * Every launch derives a fresh environment; only successful interposition is memoized.
 */
export function readyTaskClockEnvironment(
  environment: NodeJS.ProcessEnv, clock: TaskClock | undefined = readTaskClock(), probe: TaskClockProcessProbe = dateProbe
): NodeJS.ProcessEnv {
  if (clock === undefined) return environment;
  const refuse = (reason: string): Error => new Error(`NOOPOLIS_TASK_CLOCK: process clock startup probe ${reason}; refusing clocked execution`);
  if (process.platform !== "linux") throw refuse("requires Linux libfaketime interposition");
  const derived = taskClockChildEnvironment({}, clock);
  const env = taskClockProcessEnvironment(environment, derived);
  clock.now(); // A cached process clock never permits reads outside the supported calendar.
  const key = JSON.stringify([process.pid, process.platform, derived.LD_PRELOAD, derived.FAKETIME]);
  if (verified.has(key)) return env;
  for (const sentinel of [true, false]) {
    let output: string;
    try {
      // Absolute path: engine-specific PATHs need not contain system utilities.
      output = probe("/bin/date", ["-u", "+%s"], sentinel ? { ...env, FAKETIME: "-31536000" } : env);
    } catch (cause) {
      throw new Error(refuse("could not run date -u +%s (date/libfaketime missing or unusable)").message, { cause });
    }
    const seconds = Number(output.trim());
    const expected = sentinel ? Date.now() - 31_536_000_000 : clock.now();
    if (!/^-?\d+$/u.test(output.trim()) || !Number.isSafeInteger(seconds) || Math.abs(seconds * 1000 - expected) > 5000) {
      throw refuse(`did not observe ${sentinel ? "sentinel offset" : "task time"} within ±5 seconds (check libfaketime and its offset)`);
    }
  }
  verified.add(key);
  return env;
}

/** Only agent-facing tool/server children cross the shifted readiness gate. */
export const spawn: typeof childProcess.spawn = ((command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
  const argv = Array.isArray(args) ? args : [];
  const settings = (Array.isArray(args) ? options : args ?? options) as SpawnOptions | undefined;
  return childProcess.spawn(command, argv, { ...settings, env: readyTaskClockEnvironment(settings?.env ?? process.env) });
}) as typeof childProcess.spawn;

/** Engine CLIs and operational helpers stay real; no libfaketime probe runs here. */
export const spawnRealTime: typeof childProcess.spawn = ((command: string, args?: readonly string[] | SpawnOptions, options?: SpawnOptions) => {
  const argv = Array.isArray(args) ? args : [];
  const settings = (Array.isArray(args) ? options : args ?? options) as SpawnOptions | undefined;
  return childProcess.spawn(command, argv, { ...settings, env: realTimeProcessEnvironment(settings?.env ?? process.env) });
}) as typeof childProcess.spawn;
