import * as mneme from "@noopolis/mneme";
import { readTaskClock, type TaskClock } from "../runtime/taskClock.js";

type MnemeClockModule = { readonly createOffsetClock?: unknown };
type OffsetClockFactory = (input: { origin: string; anchorMs: number }) => () => number;
type MemoryConfig = Parameters<typeof mneme.createMemoryRuntime>[0];
type MemoryModule = MnemeClockModule & { createMemoryRuntime(config: MemoryConfig & { clock?: () => number }): ReturnType<typeof mneme.createMemoryRuntime> };

/** Keep construction and capability detection together while the published types catch up. */
export function createClockedMemoryRuntime(config: MemoryConfig, clock = readTaskClock(), moduleRoot: MemoryModule = mneme) {
  return moduleRoot.createMemoryRuntime({ ...config, ...memoryClockOptions(clock, moduleRoot) });
}

/** The root export is Mneme's capability signal, including across older published versions. */
export function memoryClockOptions(
  clock: TaskClock | undefined = readTaskClock(),
  moduleRoot: MnemeClockModule = mneme as MnemeClockModule
): { clock?: () => number } {
  if (clock === undefined) return {};
  if (typeof moduleRoot.createOffsetClock !== "function") {
    throw new Error("NOOPOLIS_TASK_CLOCK requires @noopolis/mneme with the root createOffsetClock export and createMemoryRuntime({ clock }) support");
  }
  const memoryClock = (moduleRoot.createOffsetClock as OffsetClockFactory)({ origin: clock.origin, anchorMs: clock.anchorEpochMs });
  if (typeof memoryClock !== "function") throw new Error("@noopolis/mneme createOffsetClock must return an epoch-ms clock function");
  return { clock: memoryClock };
}
