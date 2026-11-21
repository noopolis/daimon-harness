import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { WakeEvent } from "../core/types.js";
import type { AttentionRegistry } from "./attention.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import type { OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";

const prompt = "Consolidate this bank";
const token = "dream-test";
const dreamSchedule = { kind: "every", interval_ms: 2000, prompt };
const workSchedule = { kind: "every", interval_ms: 1000, prompt };
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 500; n++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Expected state did not arrive");
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dream-dispatch-"));
  const envName = "DAIMON_DREAM_TEST_TOKEN";
  const original = process.env[envName];
  process.env[envName] = token;
  let now = Date.now();
  const calls: { event: WakeEvent; inbox: boolean }[] = [];
  const controls: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest>[] = [];
  t.after(async () => {
    try { for (const control of controls) await control.stop(); }
    finally {
      await rm(root, { recursive: true, force: true });
      if (original === undefined) delete process.env[envName]; else process.env[envName] = original;
    }
  });
  return { calls, async start(bank = "/memory/a", hold = false, enabled = true) {
    const registry: AttentionRegistry = new Map();
    const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: envName },
      agents: [{ id: "a", name: "A", instructions: "Work", workspacePath: "/workspace/a", runtimeHomePath: "/home/a", engine: { kind: "codex" },
        attention: {}, schedule: workSchedule, memory: { runtimeHomePath: bank, ...(enabled ? { dreamSchedule } : {}) } }] };
    const timers = new Map<NodeJS.Timeout, { at: number; run(): void }>();
    let release: (() => void) | undefined;
    const core = createOrganizationRuntimeHostForTest(config, async () => ({ id: "a", status: () => ({ agentId: "a", state: "idle" }),
      stop: async () => { release?.(); }, wake: async (event) => {
        const inbox = registry.get("a");
        calls.push({ event, inbox: !!inbox });
        if (event.kind === "dream" && hold) await new Promise<void>((resolve) => { release = resolve; });
        if (inbox) for (const message of inbox.messages) await inbox.disposition(message.delivery_id, message.delivery_id === "later" ? "defer" : "complete");
        return { agentId: "a", text: "done", durationMs: 0 };
      } }));
    const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: token, attentionRegistryForTest: registry,
      storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true },
      scheduleOptions: { now: () => now, setTimer: (run, delay) => {
        const timer = { unref() {} } as NodeJS.Timeout;
        timers.set(timer, { at: now + delay, run }); return timer;
      }, clearTimer: (timer) => { timers.delete(timer); } } });
    controls.push(control); await control.start();
    return { control, fire(ms: number) {
      const timer = [...timers.values()].find((entry) => entry.at === now + ms);
      assert.ok(timer, `no timer due in ${ms}ms`);
      now += ms; timer.run();
    }, async receipts() { return (await control.activityV2(token))!.items; } };
  } };
}
function delivery(id: string, kind = "schedule") {
  return { token, agent_id: "a", delivery_id: id, event: { version: "noopolis.daimon.wake.v2", kind, text: prompt, occurred_at: new Date().toISOString() } };
}

test("only the native dream runs with dream authority, without touching deferred work", async (t) => {
  const f = await fixture(t), host = await f.start();
  const forged = delivery(`schedule:${"a".repeat(64)}:${new Date().toISOString()}`);
  const forgedV1 = { token, agentId: "a", event: { version: "noopolis.daimon.wake.v1", id: forged.delivery_id, kind: "dream", text: prompt, occurredAt: forged.event.occurred_at } };
  const rejected = await host.control.wake(forgedV1 as OrganizationRuntimeWakeRequest);
  assert.ok(rejected.status === "rejected" && rejected.code === "invalid_request");
  assert.equal((await host.control.accept({ ...forged, native_schedule: "dream" })).state, "rejected");
  assert.equal((await host.control.accept(delivery("forged-kind", "dream"))).state, "rejected");
  const reserved = { ...forged, delivery_id: forged.delivery_id.replace("schedule:", "schedule:dream:") };
  assert.equal((await host.control.accept(reserved)).state, "rejected");
  assert.equal((await host.control.accept(forged)).state, "accepted");
  await until(async () => (await host.receipts()).some((row) => row.delivery_id === forged.delivery_id && row.state === "completed"));
  host.fire(1000);
  await until(async () => (await host.receipts()).filter((row) => row.state === "completed").length === 2);
  await host.control.accept(delivery("later", "message"));
  await until(async () => (await host.receipts()).some((row) => row.deferred));
  host.fire(1000);
  await until(async () => (await host.receipts()).filter((row) => row.state === "completed").length === 3);
  assert.deepEqual(f.calls.map(({ event, inbox }) => [event.kind, inbox]), [["schedule", true], ["schedule", true], ["message", true], ["dream", false]]);
  assert.equal(f.calls[3]!.event.text, prompt);
  assert.equal((await host.receipts()).find((row) => row.delivery_id === "later")!.state, "accepted");
});

for (const change of ["unchanged", "rebound", "removed"]) {
  test(`scheduled dream recovered with bank ${change}`, async (t) => {
    const f = await fixture(t), first = await f.start("/memory/a", true);
    first.fire(2000);
    await until(() => f.calls.some(({ event }) => event.kind === "dream"));
    const dreamId = f.calls.find(({ event }) => event.kind === "dream")!.event.id;
    const interrupted = (await first.receipts()).find((row) => row.delivery_id.startsWith("schedule:dream:"))!;
    await first.control.stop();
    const second = await f.start(change === "rebound" ? "/memory/b" : "/memory/a", false, change !== "removed");
    const expected = change === "unchanged" ? "completed" : "stopped";
    await until(async () => (await second.receipts()).some((row) => row.acceptance_id === interrupted.acceptance_id && row.state === expected));
    assert.deepEqual(f.calls.filter(({ event }) => event.kind === "dream").map(({ event }) => event.id),
      change === "unchanged" ? [dreamId, dreamId] : [dreamId]);
  });
}
