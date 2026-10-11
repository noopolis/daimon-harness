import { cliChildEnvironment } from "./cliEnvironment.js";
import { readTaskClock, type TaskClock } from "../runtime/taskClock.js";
import { readyTaskClockEnvironment, type TaskClockProcessProbe } from "../runtime/taskClockProcess.js";

export type { TaskClockProcessProbe } from "../runtime/taskClockProcess.js";

/** Eager Pi readiness uses the same gate as every later child launch. */
export async function verifyTaskClockProcess(
  runtimeHomePath: string, clock: TaskClock | undefined = readTaskClock(), probe?: TaskClockProcessProbe
): Promise<void> {
  if (clock !== undefined) readyTaskClockEnvironment(cliChildEnvironment([], runtimeHomePath), clock, probe);
}
