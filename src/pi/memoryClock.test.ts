import assert from "node:assert/strict";
import test from "node:test";
import { createClockedMemoryRuntime, memoryClockOptions } from "./memoryClock.js";
import { parseTaskClock } from "../runtime/taskClock.js";

const origin = "2024-02-29T12:00:00+02:00", anchorEpochMs = 1_800_000_000_000;
const clock = parseTaskClock(JSON.stringify({ version: "noopolis.task-clock.v1", origin, anchorEpochMs }))!;

test("Mneme root capability supplies the advancing epoch-ms clock with the same origin and anchor", (t) => {
  t.mock.method(Date, "now", () => anchorEpochMs + 1234);
  const factory = t.mock.fn(({ origin: value, anchorMs }: { origin: string; anchorMs: number }) => () => Date.parse(value) + Date.now() - anchorMs);
  const config = { agentId: "a", runtimeHomePath: "/runtime", ...memoryClockOptions(clock, { createOffsetClock: factory }) };
  assert.deepEqual(factory.mock.calls[0]!.arguments, [{ origin, anchorMs: anchorEpochMs }]);
  assert.equal(config.clock!(), Date.parse(origin) + 1234);
});
test("the detected clock reaches createMemoryRuntime, while legacy unset construction stays unchanged", () => {
  const config = { agentId: "a", runtimeHomePath: "/runtime" };
  const runtime = {} as ReturnType<typeof createClockedMemoryRuntime>;
  const taskNow = () => 1234;
  let supplied: typeof config & { clock?: () => number } | undefined;
  const root = { createMemoryRuntime(input: typeof config & { clock?: () => number }) { supplied = input; return runtime; } };
  assert.equal(createClockedMemoryRuntime(config, clock, { ...root, createOffsetClock: () => taskNow }), runtime);
  assert.equal(supplied!.clock, taskNow);
  assert.equal(createClockedMemoryRuntime(config, undefined, root), runtime);
  assert.deepEqual(supplied, config);
  supplied = undefined;
  assert.throws(() => createClockedMemoryRuntime(config, clock, root), /createOffsetClock/u);
  assert.equal(supplied, undefined, "legacy Mneme must never start without its required clock");
});
test("older or malformed Mneme root exports refuse a configured clock explicitly", () => {
  for (const moduleRoot of [{}, { createOffsetClock: false }, { createOffsetClock: undefined }]) {
    assert.throws(() => memoryClockOptions(clock, moduleRoot), /NOOPOLIS_TASK_CLOCK requires @noopolis\/mneme.*createOffsetClock.*createMemoryRuntime\(\{ clock \}\)/u);
  }
  assert.throws(() => memoryClockOptions(clock, { createOffsetClock: () => 1 }), /epoch-ms clock function/u);
});
test("unset clock leaves the memory config unchanged with either module shape", () => {
  assert.deepEqual(memoryClockOptions(undefined, {}), {});
  assert.deepEqual(memoryClockOptions(undefined, { createOffsetClock: () => { throw new Error("must not call"); } }), {});
});
