import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskClock, readTaskClock, taskClockChildEnvironment, taskClockTimestamp, TASK_CLOCK_VERSION } from "./taskClock.js";

const config = { version: TASK_CLOCK_VERSION, origin: "2024-02-29T12:30:00.125+02:00", anchorEpochMs: 1_800_000_000_000 };

test("task clock advances from the original anchor and preserves the exact contract bytes", (t) => {
  const raw = JSON.stringify(config), clock = parseTaskClock(raw)!;
  t.mock.method(Date, "now", () => config.anchorEpochMs + 2500);
  assert.equal(clock.raw, raw);
  assert.equal(clock.now(), Date.parse(config.origin) + 2500);
  assert.equal(taskClockTimestamp(new Date(config.anchorEpochMs + 500).toISOString(), clock), "2024-02-29T10:30:00.625Z");
  assert.deepEqual(taskClockChildEnvironment({}, clock), {
    NOOPOLIS_TASK_CLOCK: raw, MNEME_CLOCK_ORIGIN: config.origin, MNEME_CLOCK_ANCHOR_MS: String(config.anchorEpochMs)
  });
});

for (const origin of ["2024-01-01T00:00:00Z", "2024-01-01T00:00:00-05:30", "2024-01-01T00:00:00.123456+0530", "2000-02-29T12:00:00Z", "0000-02-29T00:00:00Z"]) {
  test(`accepts ISO instant ${origin}`, () => assert.ok(parseTaskClock(JSON.stringify({ ...config, origin }))));
}
for (const anchorEpochMs of [0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
  test(`accepts safe integer anchor ${anchorEpochMs}`, () => assert.equal(parseTaskClock(JSON.stringify({ ...config, anchorEpochMs }))!.anchorEpochMs, anchorEpochMs));
}
const invalid: unknown[] = [null, [], true, 1, "text", {}, { ...config, version: "v2" }, { ...config, extra: true },
  { origin: config.origin, anchorEpochMs: 0 }, { version: config.version, origin: config.origin },
  ...[1.5, "123", null, Number.MAX_SAFE_INTEGER + 1].map((anchorEpochMs) => ({ ...config, anchorEpochMs })),
  ...[null, 123, "", "2024-01-01", "2024-01-01T12:00:00", "2023-02-29T00:00:00Z", "2024-02-30T00:00:00Z",
    "1900-02-29T00:00:00Z", "2024-13-01T00:00:00Z", "2024-01-01T24:30:00Z", "2024-01-01T00:00:00+25:00", "not a date"]
    .map((origin) => ({ ...config, origin }))];
for (const [i, value] of invalid.entries()) {
  test(`refuses invalid task clock ${i}`, () => assert.throws(() => parseTaskClock(JSON.stringify(value)), /NOOPOLIS_TASK_CLOCK:/u));
}
test("a set empty, malformed or non-finite JSON value is never an unset clock", () => {
  for (const raw of ["", " ", "{", '{"version":"noopolis.task-clock.v1","origin":"2024-01-01T00:00:00Z","anchorEpochMs":1e999}']) {
    assert.throws(() => readTaskClock({ NOOPOLIS_TASK_CLOCK: raw }), /NOOPOLIS_TASK_CLOCK:/u);
  }
});
test("unset clock derives no variables and preserves timestamps", () => {
  assert.equal(readTaskClock({}), undefined);
  assert.deepEqual(taskClockChildEnvironment({ MNEME_CLOCK_ORIGIN: "declared" }, readTaskClock({})), {});
  assert.equal(taskClockTimestamp(config.origin, readTaskClock({})), config.origin);
});
test("declared clock values must agree exactly, including the serialized anchor", () => {
  const clock = parseTaskClock(JSON.stringify(config))!, env = taskClockChildEnvironment({}, clock);
  assert.deepEqual(taskClockChildEnvironment(env, clock), env);
  for (const name of Object.keys(env)) {
    assert.throws(() => taskClockChildEnvironment({ [name]: "different" }, clock), new RegExp(`conflicts with ${name}`));
  }
});
