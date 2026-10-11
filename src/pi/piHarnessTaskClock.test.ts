import { resetTaskClockProcessForTest } from "../runtime/taskClockProcess.js";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import * as mneme from "@noopolis/mneme";
import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import { formatWakePrompt } from "./prompts.js";
import { cliChildEnvironment } from "./cliEnvironment.js";

const anchorEpochMs = 1_800_000_000_123, origin = "2024-02-29T12:00:00+02:00";
const raw = JSON.stringify({ version: "noopolis.task-clock.v1", origin, anchorEpochMs });
const model = { auth: { method: "none" as const }, endpoint: { baseUrl: "http://127.0.0.1", compatibility: "openai" as const }, name: "stub", provider: "stub" };
async function fixture(t: TestContext) {
  resetTaskClockProcessForTest();
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, NOOPOLIS_RUN_ID: "clock-tests", LD_PRELOAD: "/caller/libfaketime.so.1" };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-pi-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  return { root, input: { id: "a", name: "A", instructions: "test", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "home") } };
}
test("Pi startup rejects an invalid set clock before creating an agent home or session", async (t) => {
  const { root, input } = await fixture(t);
  process.env.NOOPOLIS_TASK_CLOCK = "";
  const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), model, sessionFactory: async () => { throw new Error("session must not start"); } });
  await assert.rejects(adapter.startAgent(input), /NOOPOLIS_TASK_CLOCK/u);
  await assert.rejects(access(input.runtimeHomePath), /ENOENT/u);
});
test("installed Mneme without the root capability refuses memory startup before side effects", async (t) => {
  if ("createOffsetClock" in mneme) { t.skip("installed Mneme has acquired the capability; module-shape tests cover both branches"); return; }
  const { root, input } = await fixture(t);
  const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), model, memory: {}, sessionFactory: async () => { throw new Error("session must not start"); } });
  await assert.rejects(adapter.startAgent(input), /@noopolis\/mneme.*createOffsetClock/u);
  await assert.rejects(access(input.runtimeHomePath), /ENOENT/u);
});
test("startup probes sentinel and offset once and Pi bash receives only the process clock", async (t) => {
  const { root, input } = await fixture(t);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => { Object.defineProperty(process, "platform", platform); });
  Object.assign(process.env, { MNEME_CLOCK_ORIGIN: origin, MNEME_CLOCK_ANCHOR_MS: String(anchorEpochMs), MNEME_CLOCK_FUTURE: "1", FAKETIME_SKIP_CMDS: "bash", FAKETIME_ONLY_CMDS: "date", DYLD_INSERT_LIBRARIES: "/other" });
  let now = anchorEpochMs + 500;
  t.mock.method(Date, "now", () => now);
  const prompts: string[] = [], childResults: string[] = [];
  const factory: PiSessionFactory = async (options) => {
    const bash = options.customTools?.find((tool) => tool.name === "bash");
    assert.ok(bash, "task clock alone must install the bash env adapter");
    return { session: { subscribe: () => () => undefined, dispose() {}, async prompt(text) {
      prompts.push(text);
      const result = await bash.execute("env", { command: "printf '%s\\n' \"$FAKETIME\" \"$FAKETIME_DONT_FAKE_MONOTONIC\" \"$LD_PRELOAD\" \"${NOOPOLIS_TASK_CLOCK-unset}\" \"${MNEME_CLOCK_ORIGIN-unset}\" \"${MNEME_CLOCK_ANCHOR_MS-unset}\" \"${MNEME_CLOCK_FUTURE-unset}\" \"${FAKETIME_SKIP_CMDS-unset}\" \"${FAKETIME_ONLY_CMDS-unset}\" \"${DYLD_INSERT_LIBRARIES-unset}\"" }, undefined, undefined, {} as never);
      childResults.push((result.content[0] as { text: string }).text);
    } } };
  };
  let probes = 0;
  const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), model, sessionFactory: factory }, (command, args, env) => {
    probes++;
    assert.equal(command, "/bin/date"); assert.deepEqual(args, ["-u", "+%s"]);
    assert.deepEqual(env, { ...cliChildEnvironment([], input.runtimeHomePath), ...(probes === 1 ? { FAKETIME: "-31536000" } : {}) });
    return String(Math.floor((now + Number(env.FAKETIME) * 1000) / 1000));
  });
  const handle = await adapter.startAgent(input);
  t.after(() => handle.stop());
  await handle.wake({ id: "one", kind: "manual", text: "hello" });
  now += 2000;
  await handle.wake({ id: "two", kind: "dream", text: "reflect" });
  assert.equal(probes, 2, "dream sessions and later wakes must not repeat either startup probe");
  assert.equal(prompts[0], formatWakePrompt({ id: "one", kind: "manual", text: "hello" }));
  assert.match(prompts[1]!, /^## Dream Mode/u);
  for (const result of childResults) {
    assert.ok(result.trim().endsWith(["-90799200.123", "1", "/caller/libfaketime.so.1", ...Array(7).fill("unset")].join("\n")));
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;

});
