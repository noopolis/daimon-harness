import assert from "node:assert/strict";
import test from "node:test";
import { parseTaskClock, readTaskClock, taskClockChildEnvironment, taskClockPreload, taskClockProcessEnvironment, taskClockTimestamp, TASK_CLOCK_VERSION } from "./taskClock.js";

const config = { version: TASK_CLOCK_VERSION, origin: "2024-02-29T12:30:00.125+02:00", anchorEpochMs: 1_800_000_000_000 };

test("task clock advances from the original anchor and preserves the exact contract bytes", (t) => {
  const raw = JSON.stringify(config), clock = parseTaskClock(raw)!;
  t.mock.method(Date, "now", () => config.anchorEpochMs + 2500);
  assert.equal(clock.raw, raw);
  assert.equal(clock.now(), Date.parse(config.origin) + 2500);
  assert.equal(taskClockTimestamp(new Date(config.anchorEpochMs + 500).toISOString(), clock), "2024-02-29T10:30:00.625Z");
  assert.deepEqual(taskClockChildEnvironment({}, clock, {}), {
    FAKETIME: "-90797399.875", FAKETIME_DONT_FAKE_MONOTONIC: "1", LC_ALL: "C"
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
test("every declared clock control is rejected, even empty or equal to the derived value", () => {
  const clock = parseTaskClock(JSON.stringify(config))!, environment = { LD_PRELOAD: "/caller/libfaketime.so.1" };
  const derived = taskClockChildEnvironment({}, clock, environment);
  for (const name of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_FUTURE", "FAKETIME", "FAKETIME_DONT_FAKE_MONOTONIC", "FAKETIME_SKIP_CMDS", "FAKETIME_ONLY_CMDS", "FAKETIME_FUTURE", "NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "MNEME_CLOCK_ANCHOR_MS", "MNEME_CLOCK_FUTURE"]) {
    for (const value of ["", derived[name] ?? "declared"]) {
      assert.throws(() => taskClockChildEnvironment({ [name]: value }, clock, environment), new RegExp(`conflicts with ${name}`));
    }
  }
  assert.deepEqual(taskClockChildEnvironment({ ORDINARY: "retained" }, clock, environment), derived);
});


test("libfaketime allowlist rejects mixed or unrelated loader values", () => {
  for (const value of [undefined, "", "/tmp/libclock.so", "/tmp/libfaketime.dylib", "/tmp/libfaketime.so.1:/tmp/evil.so", "libfaketime.so.1 libother.so"]) {
    assert.equal(taskClockPreload(value), undefined);
    assert.equal(taskClockChildEnvironment({}, parseTaskClock(JSON.stringify(config)), { LD_PRELOAD: value }).LD_PRELOAD, undefined);
  }
  for (const value of ["/usr/lib/libfaketime.so.1", "libfaketimeMT.so.1"]) {
    assert.equal(taskClockChildEnvironment({}, parseTaskClock(JSON.stringify(config)), { LD_PRELOAD: value }).LD_PRELOAD, value);
    assert.deepEqual(taskClockChildEnvironment({}, undefined, { LD_PRELOAD: value }), {});
  }
});

test("relative offsets preserve signed milliseconds, including the shared Spawnfile vector", () => {
  for (const [offset, expected] of [[-3600000, "-3600"], [120000, "+120"], [0, "+0"], [499, "+0.499"], [500, "+0.500"], [1499, "+1.499"], [1500, "+1.500"], [-1501, "-1.501"], [-1, "-0.001"]] as const) {
    const clock = parseTaskClock(JSON.stringify({ ...config, origin: new Date(config.anchorEpochMs + offset).toISOString() }))!;
    assert.equal(taskClockChildEnvironment({}, clock).FAKETIME, expected);
  }
  const clock = parseTaskClock(JSON.stringify({ ...config, origin: "2001-01-01T00:00:00.000Z", anchorEpochMs: 1821692800250 }))!;
  assert.equal(taskClockChildEnvironment({}, clock).FAKETIME, "-843385600.250");
});

test("child process time and host task time agree at second, midnight and leap-day boundaries", () => {
  for (const origin of ["2000-02-28T23:59:59.999Z", "2000-02-29T23:59:59.500Z", "2001-01-01T00:00:00.000Z"]) {
    const clock = parseTaskClock(JSON.stringify({ ...config, origin, anchorEpochMs: 1821692800250 }))!;
    const offsetMs = Number(taskClockChildEnvironment({}, clock).FAKETIME) * 1000;
    for (const elapsed of [0, 1, 499, 500, 1000]) {
      assert.equal(new Date(clock.anchorEpochMs + elapsed + offsetMs).toISOString(), new Date(clock.at(clock.anchorEpochMs + elapsed)).toISOString());
    }
  }
});

test("inherited environments strip every offset and loader control before assigning the process clock", () => {
  const clock = parseTaskClock(JSON.stringify(config))!;
  const environment = { LD_PRELOAD: "/caller/libfaketime.so.1" };
  const expected = taskClockChildEnvironment({}, clock, environment);
  const inherited = { PATH: "/bin", NOOPOLIS_TASK_CLOCK: clock.raw, MNEME_CLOCK_ORIGIN: clock.origin, MNEME_CLOCK_ANCHOR_MS: String(clock.anchorEpochMs), MNEME_CLOCK_FUTURE: "1", FAKETIME: "wrong", FAKETIME_SKIP_CMDS: "node", FAKETIME_ONLY_CMDS: "date", DYLD_INSERT_LIBRARIES: "/other", LD_PRELOAD: "/other.so" };
  assert.deepEqual(taskClockProcessEnvironment(inherited, expected), { PATH: "/bin", ...expected });
  assert.deepEqual(taskClockProcessEnvironment(inherited, {}), inherited);
});
