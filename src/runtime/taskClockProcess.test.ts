import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readyTaskClockEnvironment, resetTaskClockProcessForTest, spawn, type TaskClockProcessProbe } from "./taskClockProcess.js";
import { readChild } from "../pi/cliChildOutput.js";

function fixture(t: TestContext) {
  const previous = process.env, platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const now = Date.now();
  process.env = { ...previous, LD_PRELOAD: "/test/libfaketime.so.1" };
  Object.defineProperty(process, "platform", { value: "linux" });
  resetTaskClockProcessForTest();
  t.mock.method(Date, "now", () => now);
  t.after(() => { process.env = previous; Object.defineProperty(process, "platform", platform); resetTaskClockProcessForTest(); });
  return (offset: number) => { process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: new Date(now + offset).toISOString(), anchorEpochMs: now }); };
}

test("readiness memoizes successful sentinel and offset probes per process, preload and offset", (t) => {
  const offset = fixture(t); offset(0);
  const calls: NodeJS.ProcessEnv[] = [];
  const probe: TaskClockProcessProbe = (command, args, env) => {
    assert.equal(command, "/bin/date"); assert.deepEqual(args, ["-u", "+%s"]);
    calls.push(env);
    return String(Math.floor((Date.now() + Number(env.FAKETIME) * 1000) / 1000));
  };
  const inherited = { PATH: "/engine-only", FAKETIME_SKIP_CMDS: "node", NOOPOLIS_TASK_CLOCK: "must-be-removed" };
  const first = readyTaskClockEnvironment(inherited, undefined, probe);
  assert.deepEqual(calls.map((env) => env.FAKETIME), ["-31536000", "+0"]);
  assert.equal(first.LD_PRELOAD, process.env.LD_PRELOAD);
  assert.equal(first.FAKETIME_SKIP_CMDS, undefined); assert.equal(first.NOOPOLIS_TASK_CLOCK, undefined);
  assert.deepEqual(readyTaskClockEnvironment(inherited, undefined, probe), first);
  assert.equal(calls.length, 2);
  offset(1250); readyTaskClockEnvironment(inherited, undefined, probe);
  assert.equal(calls.length, 4);
  process.env.LD_PRELOAD = "/different/libfaketime.so.1";
  readyTaskClockEnvironment(inherited, undefined, probe);
  assert.equal(calls.length, 6);
  delete process.env.LD_PRELOAD;
  assert.throws(() => readyTaskClockEnvironment(inherited, undefined, probe), /requires caller-provided LD_PRELOAD/u);
  assert.equal(calls.length, 6);
});

test("failed probes never grant readiness, including a failed offset after a passing sentinel", (t) => {
  const offset = fixture(t); offset(3000);
  let calls = 0;
  const broken: TaskClockProcessProbe = (_command, _args, env) => {
    calls++;
    return env.FAKETIME === "-31536000" ? String(Math.floor((Date.now() - 31_536_000_000) / 1000)) : "invalid";
  };
  for (let attempt = 0; attempt < 2; attempt++) assert.throws(() => readyTaskClockEnvironment({}, undefined, broken), /did not observe task time/u);
  assert.equal(calls, 4);
});

test("cached readiness still refuses a task read beyond the supported range", (t) => {
  const offset = fixture(t); offset(0);
  readyTaskClockEnvironment({}, undefined, (_command, _args, env) => String(Math.floor((Date.now() + Number(env.FAKETIME) * 1000) / 1000)));
  t.mock.method(Date, "now", () => Date.parse("+010000-01-01T00:00:00Z"));
  assert.throws(() => readyTaskClockEnvironment({}), /task instant must be within/u);
});

test("unset launches preserve explicit options even when the optional argv is omitted", async (t) => {
  const previous = process.env; process.env = { ...previous }; delete process.env.NOOPOLIS_TASK_CLOCK;
  t.after(() => { process.env = previous; });
  const child = spawn(process.execPath, undefined, { env: { CLOCK_TEST_MARKER: "preserved" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.end("console.log(process.env.CLOCK_TEST_MARKER)");
  assert.equal((await readChild(child, 1000, [])).trim(), "preserved");
});
