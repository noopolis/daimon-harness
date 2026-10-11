import childProcess from "node:child_process";
import { resetTaskClockProcessForTest } from "../runtime/taskClockProcess.js";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { cliChildEnvironment } from "./cliEnvironment.js";
import { PiHarnessAdapter } from "./piHarness.js";
import { verifyTaskClockProcess, type TaskClockProcessProbe } from "./taskClockProcess.js";
import { readTaskClock } from "../runtime/taskClock.js";

function environment(t: TestContext) {
  resetTaskClockProcessForTest();
  const previous = process.env;
  process.env = { ...previous, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }), LD_PRELOAD: "/caller/libfaketime.so.1" };
  t.after(() => { process.env = previous; });
}

function linux(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => { Object.defineProperty(process, "platform", descriptor); });
}
const shifted: TaskClockProcessProbe = (_command, _args, env) => `${Math.floor((Date.now() + Number(env.FAKETIME) * 1000) / 1000)}\n`;

test("startup probe uses sentinel then real offset with date argv and the CLI child environment", async (t) => {
  environment(t);
  linux(t);
  let calls = 0;
  await verifyTaskClockProcess("/runtime", undefined, (command, args, env) => {
    calls++;
    assert.equal(command, "/bin/date"); assert.deepEqual(args, ["-u", "+%s"]);
    assert.deepEqual(env, { ...cliChildEnvironment([], "/runtime"), ...(calls === 1 ? { FAKETIME: "-31536000" } : {}) });
    return shifted(command, args, env);
  });
  assert.equal(calls, 2);
  delete process.env.NOOPOLIS_TASK_CLOCK;
  await verifyTaskClockProcess("/runtime", undefined, () => { throw new Error("unset must not probe"); });
});

test("startup refuses mismatched, malformed, missing-date and missing-preload observations", async (t) => {
  environment(t);
  linux(t);
  for (const output of [String(Math.floor(Date.now() / 1000)), "", "not-a-time", "NaN", `${Math.floor(readTaskClock()!.now() / 1000) + 6}`]) {
    let calls = 0;
    await assert.rejects(verifyTaskClockProcess("/runtime", undefined, (command, args, env) => ++calls === 1 ? shifted(command, args, env) : output), /did not observe task time.*refusing clocked execution/u);
    assert.equal(calls, 2, "the real-offset check must run after sentinel interposition succeeds");
  }
  await assert.rejects(verifyTaskClockProcess("/runtime", undefined, () => { throw Object.assign(new Error("date"), { code: "ENOENT" }); }), /date\/libfaketime missing or unusable/u);
  for (const value of [undefined, "/tmp/libunrelated.so", "/caller/libfaketime.so.1:/tmp/libunrelated.so"]) {
    if (value === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = value;
    let probes = 0;
    await assert.rejects(verifyTaskClockProcess("/runtime", undefined, () => { probes++; return String(Math.floor(readTaskClock()!.now() / 1000)); }), /requires caller-provided LD_PRELOAD/u);
    assert.equal(probes, 0);
  }
});

test("the real date probe refuses an unavailable preload even for a near-zero offset", async (t) => {
  environment(t);
  process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: new Date(Date.now() + 3000).toISOString(), anchorEpochMs: Date.now() });
  // The path does not exist: Linux ignores it with a loader warning; macOS ignores LD_PRELOAD.
  await assert.rejects(verifyTaskClockProcess(os.tmpdir()), /process clock startup probe.*refusing clocked execution/u);
});

test("non-Linux platforms refuse clocked execution before invoking a successful probe", async (t) => {
  environment(t);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  t.after(() => { Object.defineProperty(process, "platform", descriptor); });
  for (const platform of ["darwin", "win32", "freebsd"]) {
    Object.defineProperty(process, "platform", { value: platform });
    let calls = 0;
    await assert.rejects(verifyTaskClockProcess("/runtime", undefined, (...args) => { calls++; return shifted(...args); }), /requires Linux.*refusing clocked execution/u);
    assert.equal(calls, 0);
  }
});

test("near-zero offsets still require sentinel interposition, then verify the real offset", async (t) => {
  environment(t); linux(t);
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const offset of [0, 1, 3000, -3000]) {
    process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: new Date(now + offset).toISOString(), anchorEpochMs: now });
    let calls = 0;
    await assert.rejects(verifyTaskClockProcess("/runtime", undefined, () => { calls++; return String(Math.floor(now / 1000)); }), /did not observe sentinel offset/u);
    assert.equal(calls, 1);
    await verifyTaskClockProcess("/runtime", undefined, shifted);
  }
});

test("a loader warning refuses startup even when date exits zero with matching output", async (t) => {
  environment(t);
  linux(t);
  t.mock.method(childProcess, "spawnSync", (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => ({
    status: 0, stdout: String(Math.floor((Date.now() + Number(options.env.FAKETIME) * 1000) / 1000)),
    stderr: "loader: preload could not be loaded; ignored\n"
  }));
  await assert.rejects(verifyTaskClockProcess(os.tmpdir()), /process clock startup probe could not run/u);
});

for (const mode of ["missing-preload", "mismatch", "missing-date"] as const) {
  test(`Pi startup refuses ${mode} before home/session creation`, async (t) => {
    environment(t);
    linux(t);
    if (mode === "missing-preload") delete process.env.LD_PRELOAD;
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-probe-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let sessions = 0;
    const probe: TaskClockProcessProbe = () => {
      if (mode === "missing-date") throw new Error("ENOENT");
      return String(Math.floor(Date.now() / 1000));
    };
    const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), sessionFactory: async () => { sessions++; throw new Error("session must not start"); } }, probe);
    const home = path.join(root, "home");
    await assert.rejects(adapter.startAgent({ id: "a", name: "A", instructions: "test", runtimeHomePath: home, workspacePath: path.join(root, "workspace") }), /process clock startup probe/u);
    assert.equal(sessions, 0);
    await assert.rejects(access(home), /ENOENT/u);
  });
}
