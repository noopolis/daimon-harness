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
test("startup probes once through the CLI builder and Pi bash receives the process clock", async (t) => {
  const { root, input } = await fixture(t);
  let now = anchorEpochMs + 500;
  t.mock.method(Date, "now", () => now);
  const prompts: string[] = [], childResults: string[] = [];
  const factory: PiSessionFactory = async (options) => {
    const bash = options.customTools?.find((tool) => tool.name === "bash");
    assert.ok(bash, "task clock alone must install the bash env adapter");
    return { session: { subscribe: () => () => undefined, dispose() {}, async prompt(text) {
      prompts.push(text);
      childResults.push(JSON.stringify(await bash.execute("env", { command: "printf '%s\\n' \"$NOOPOLIS_TASK_CLOCK\" \"$MNEME_CLOCK_ORIGIN\" \"$MNEME_CLOCK_ANCHOR_MS\"" }, undefined, undefined, {} as never)));
    } } };
  };
  let probes = 0;
  const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), model, sessionFactory: factory }, async (command, args, env) => {
    probes++;
    assert.equal(command, "date"); assert.deepEqual(args, ["-u", "+%s"]);
    assert.deepEqual(env, cliChildEnvironment([], input.runtimeHomePath));
    return String(Math.floor((Date.parse(origin) + now - anchorEpochMs) / 1000));
  });
  const handle = await adapter.startAgent(input);
  t.after(() => handle.stop());
  await handle.wake({ id: "one", kind: "manual", text: "hello" });
  now += 2000;
  await handle.wake({ id: "two", kind: "dream", text: "reflect" });
  assert.equal(probes, 1, "dream sessions and later wakes must not repeat startup probes");
  assert.equal(prompts[0], formatWakePrompt({ id: "one", kind: "manual", text: "hello" }));
  assert.match(prompts[1]!, /^## Dream Mode/u);
  for (const result of childResults) {
    assert.ok(result.includes(JSON.stringify(raw).slice(1, -1)));
    assert.ok(result.includes(origin)); assert.ok(result.includes(String(anchorEpochMs)));
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;

});
