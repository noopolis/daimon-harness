import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { WakeEvent } from "../core/types.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { prepareProductionReadiness } from "./organizationRuntimeReadiness.js";
import { startOrganizationRuntimeEngine } from "./engineDispatcher.js";
import type { EngineBrokerTurnClient } from "./engineBrokerControlClient.js";
import type { AttentionRegistry } from "./attention.js";
import { attentionTools } from "./attention.js";
import { parseOrganizationRuntimeConfig } from "./organizationRuntime.js";

const anchorEpochMs = 1_800_000_000_000;
const raw = JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2024-02-29T12:00:00+02:00", anchorEpochMs });
const config = () => ({ version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CLOCK_TEST_TOKEN" },
  agents: [{ id: "a", name: "A", instructions: "test", workspacePath: "/workspace/a", runtimeHomePath: "/home/a", engine: { kind: "codex" }, attention: {}, schedule: { kind: "every", interval_ms: 1000, prompt: "work" } }] });
function environment(t: TestContext) {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, CLOCK_TEST_TOKEN: "test" };
  t.after(() => { process.env = previous; });
}
test("host rejects invalid clock or conflicting MCP declarations before preflight and factories", async (t) => {
  environment(t);
  let sideEffects = 0;
  const host = createOrganizationRuntimeHostForTest(config(), async () => { sideEffects++; throw new Error("factory"); }, async () => { sideEffects++; throw new Error("preflight"); });
  process.env.NOOPOLIS_TASK_CLOCK = "";
  await assert.rejects(host.start(), /NOOPOLIS_TASK_CLOCK/u);
  assert.equal(sideEffects, 0);
  process.env.NOOPOLIS_TASK_CLOCK = raw;
  const declared = config();
  const agent = { ...declared.agents[0]!, mcp: [{ name: "clock", transport: "stdio", command: "/server", args: [], env: { MNEME_CLOCK_ANCHOR_MS: "0" }, tools: ["time"] }] };
  const conflict = createOrganizationRuntimeHostForTest({ ...declared, agents: [agent] }, async () => { sideEffects++; throw new Error("factory"); });
  await assert.rejects(conflict.start(), /conflicts with MNEME_CLOCK_ANCHOR_MS/u);
  assert.equal(sideEffects, 0);
});
test("native broker clock gaps are reported without refusing readiness or dispatch", async (t) => {
  environment(t);
  const value = config(); value.agents[0]!.engine = { kind: "grok" };
  const parsed = parseOrganizationRuntimeConfig(value);
  const warning = t.mock.method(console, "warn", () => {});
  // These intentionally absent production roots fail ordinary readiness, not clock coverage.
  await assert.rejects(prepareProductionReadiness(parsed), (error: Error) => !error.message.includes("NOOPOLIS_TASK_CLOCK"));
  const paths = { verify: async () => { throw new Error("path readiness reached"); } };
  await assert.rejects(startOrganizationRuntimeEngine(parsed.agents[0]!, "CLOCK_TEST_TOKEN", paths as never, undefined, {} as EngineBrokerTurnClient), /path readiness reached/u);
  assert.equal(warning.mock.callCount(), 2);
  for (const call of warning.mock.calls) assert.match(call.arguments[0], /engine=grok.*wake allowed/u);
});
test("schedule delays remain real while durable occurrences and delivery IDs use task time", { timeout: 5000 }, async (t) => {
  environment(t);
  const realAnchor = Date.now();
  let realNow = realAnchor;
  process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2024-02-29T12:00:00+02:00", anchorEpochMs: realAnchor });
  t.mock.method(Date, "now", () => realNow);
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-schedule-"));
  let timer: (() => void) | undefined, delay: number | undefined;
  let deliver!: (event: WakeEvent) => void;
  const seen = new Promise<WakeEvent>((resolve) => { deliver = resolve; });
  const registry: AttentionRegistry = new Map();
  let inbox: unknown;
  const core = createOrganizationRuntimeHostForTest(config(), async () => ({ id: "a", status: () => ({ agentId: "a", state: "idle" }), stop: async () => {}, wake: async (event) => {
    inbox = (await attentionTools("a", registry)[0]!.execute("read", {}, undefined, undefined, {} as never)).details;
    deliver(event); return { agentId: "a", text: "", durationMs: 0 };
  } }));
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config(), core, {
    acceptanceStorePath: root, controlToken: "test", attentionRegistryForTest: registry,
    storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true },
    scheduleOptions: { setTimer: (callback, milliseconds) => { timer = callback; delay = milliseconds; return { unref() {} } as NodeJS.Timeout; }, clearTimer() {} }
  });
  t.after(async () => { try { await control.stop(); } finally { await rm(root, { recursive: true, force: true }); } });
  await control.start();
  assert.equal(delay, 1000, "one task second is one real second");
  const state = JSON.parse(await readFile(path.join(root, "schedule-state.v1.json"), "utf8"));
  assert.equal((Object.values(state.schedules)[0] as { next_due_ms: number }).next_due_ms, Date.parse("2024-02-29T10:00:01.000Z"));
  realNow += 1000; timer!();
  const event = await seen;
  assert.match(event.text, /2024-02-29T10:00:01\.000Z/u);
  assert.equal((inbox as { messages: { occurred_at: string }[] }).messages[0]!.occurred_at, "2024-02-29T10:00:01.000Z");
  assert.match((inbox as { messages: { delivery_id: string }[] }).messages[0]!.delivery_id, /:2024-02-29T10:00:01\.000Z$/u);
});
