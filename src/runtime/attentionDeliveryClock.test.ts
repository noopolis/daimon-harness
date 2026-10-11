import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { attentionTools, type AttentionMessage, type AttentionRegistry } from "./attention.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";
import { parseStoredWakeAcceptance } from "./wakeAcceptanceRecord.js";

const real = Date.parse("2026-10-11T12:00:00.000Z"), origin = Date.parse("2001-01-01T00:00:00.000Z");
const iso = (at: number) => new Date(at).toISOString();
const historical = '{"created_at":"1999-12-31T23:59:00.000Z","body":"historical Moltnet message"}';
const delivery = (id: string, at: number, kind: "message" | "schedule" | "manual" = "message") => ({
  token: "test", agent_id: "a", delivery_id: id,
  event: { version: "noopolis.daimon.wake.v2" as const, kind, text: historical, occurred_at: iso(at) }
});

async function fixture(t: TestContext, clocked: boolean, scheduled = false) {
  const previous = process.env; process.env = { ...previous };
  if (clocked) process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: iso(origin), anchorEpochMs: real });
  else delete process.env.NOOPOLIS_TASK_CLOCK;
  let realNow = real + 120_000;
  t.mock.timers.enable({ apis: ["Date"], now: realNow });
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-delivery-clock-"));
  const controls: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest>[] = [];
  t.after(async () => { try { for (const control of controls) await control.stop(); } finally { process.env = previous; await rm(root, { recursive: true, force: true }); } });
  const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CLOCK_TEST_TOKEN" },
    agents: [{ id: "a", name: "A", instructions: "test", workspacePath: "/workspace/a", runtimeHomePath: "/home/a", engine: { kind: "codex" }, attention: {},
      schedule: scheduled ? { kind: "every", interval_ms: 60_000, prompt: "scheduled work" } : { kind: "disabled" } }] };
  return {
    advance(ms: number) { realNow += ms; t.mock.timers.setTime(realNow); },
    async stored() {
      const files = (await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
      return await Promise.all(files.map(async (name) => parseStoredWakeAcceptance(JSON.parse(await readFile(path.join(root, name), "utf8")))));
    },
    async start() {
      const registry: AttentionRegistry = new Map();
      const wakes: OrganizationRuntimeWakeRequest[] = [];
      const releases: Array<(result: OrganizationRuntimeWakeResult) => void> = [];
      let timer!: () => void;
      const core: OrganizationRuntimeHost = {
        async start() {},
        async stop() {
          releases.forEach((resolve, index) => resolve({ version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "a", wakeId: wakes[index]!.event.id, code: "active_wake_aborted" }));
          return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" };
        },
        async health() { return { version: "noopolis.daimon.organization-runtime-health.v1", state: "running", agents: [] }; },
        async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1", items: [] }; },
        wake(request) { wakes.push(request); return new Promise((resolve) => { releases.push(resolve); }); }
      };
      const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: "test", attentionRegistryForTest: registry,
        storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true },
        scheduleOptions: { now: () => realNow, setTimer: (callback) => { timer = callback; return { unref() {} } as NodeJS.Timeout; }, clearTimer() {} } });
      controls.push(control); await control.start();
      return {
        control, fire: () => timer(),
        async wake(index: number) {
          for (let n = 0; n < 1000; n++) {
            if (wakes[index]) return wakes[index]!;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          assert.fail(`wake ${index} did not arrive`);
        },
        async inbox() {
          const result = await attentionTools("a", registry)[0]!.execute("read", {}, undefined, undefined, {} as never);
          assert.equal((result.content[0] as { text: string }).text, JSON.stringify(result.details));
          return (result.details as { messages: AttentionMessage[] }).messages;
        },
        async complete(index: number) {
          for (const message of registry.get("a")!.messages) await registry.get("a")!.disposition(message.delivery_id, "complete");
          releases[index]!({ version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: "a", wakeId: wakes[index]!.event.id, text: "", durationMs: 0 });
        }
      };
    }
  };
}

for (const clocked of [true, false]) {
  test(`batched deliveries preserve offsets and age across inbox reads and replay (clocked=${clocked})`, { timeout: 15_000 }, async (t) => {
    const rig = await fixture(t, clocked), host = await rig.start();
    await host.control.accept(delivery("blocker", real, "manual")); await host.wake(0);
    const requests = [delivery("older", real - 300_000), delivery("newer", real - 285_000)];
    for (const request of requests) { rig.advance(1); assert.equal((await host.control.accept(request)).state, "accepted"); }
    await host.complete(0);
    const wake = await host.wake(1), inbox = await host.inbox();
    const expected = requests.map((request) => ({ ...request.event, occurred_at: iso(Date.parse(request.event.occurred_at) + (clocked ? origin - real : 0)) }));
    assert.deepEqual(inbox.map(({ occurred_at }) => occurred_at), expected.map(({ occurred_at }) => occurred_at));
    assert.equal(Date.parse(inbox[1]!.occurred_at) - Date.parse(inbox[0]!.occurred_at), 15_000);
    assert.equal((Date.now() + (clocked ? origin - real : 0)) - Date.parse(inbox[0]!.occurred_at), Date.now() - (real - 300_000));
    assert.equal(wake.event.occurredAt, expected[0]!.occurred_at);
    assert.ok(wake.event.text.endsWith(`Machine-readable payload: ${JSON.stringify(inbox)}`));
    assert.ok(inbox.every((message) => message.text === historical));
    rig.advance(60_000); assert.deepEqual(await host.inbox(), inbox, "reading later cannot reproject or replace delivery times");
    await host.control.stop();
    const stored = await rig.stored();
    for (const request of requests) assert.deepEqual(stored.find((record) => record.delivery_id === request.delivery_id)!.event, request.event);
    const restarted = await rig.start(), replay = await restarted.wake(0);
    assert.equal(replay.event.occurredAt, wake.event.occurredAt);
    assert.equal(replay.event.text, wake.event.text);
    assert.deepEqual(await restarted.inbox(), inbox);
    await restarted.complete(0);
  });

  test(`external schedule cannot forge native provenance (clocked=${clocked})`, { timeout: 10_000 }, async (t) => {
    const rig = await fixture(t, clocked), host = await rig.start();
    const request = delivery(`schedule:${"a".repeat(64)}:${iso(real)}`, real, "schedule");
    for (const forged of [{ ...request, native_schedule: true }, { ...request, event: { ...request.event, native_schedule: true } }]) {
      assert.equal((await host.control.accept(forged)).state, "rejected");
    }
    // A JavaScript caller can pass extra arguments; the public wrapper must discard them.
    const accept = host.control.accept as (value: unknown, nativeSchedule: boolean) => ReturnType<typeof host.control.accept>;
    assert.equal((await accept(request, true)).state, "accepted");
    const wake = await host.wake(0), inbox = await host.inbox();
    assert.equal(wake.event.occurredAt, iso(clocked ? origin : real));
    assert.equal(inbox[0]!.occurred_at, wake.event.occurredAt);
    assert.ok(wake.event.text.endsWith(`Machine-readable payload: ${JSON.stringify(inbox)}`));
    await host.complete(0); await host.control.stop();
    assert.equal((await rig.stored())[0]!.native_schedule, undefined);
  });

  test(`native schedule preserves its occurrence through durable replay (clocked=${clocked})`, { timeout: 10_000 }, async (t) => {
    const rig = await fixture(t, clocked, true), host = await rig.start();
    rig.advance(90_000); host.fire(); // The timer is late; occurrence time must stay at due, not now.
    const wake = await host.wake(0), inbox = await host.inbox();
    const expected = iso((clocked ? origin : real) + 180_000);
    assert.equal(wake.event.occurredAt, expected);
    assert.equal(inbox[0]!.occurred_at, expected);
    assert.ok(wake.event.text.endsWith(`Machine-readable payload: ${JSON.stringify(inbox)}`));
    assert.equal(Object.hasOwn(inbox[0]!, "native_schedule"), false, "private provenance is not model-visible");
    await host.control.stop();
    const [record] = await rig.stored();
    assert.equal(record!.native_schedule, true);
    assert.equal(record!.event.occurred_at, expected);
    const restarted = await rig.start(), replay = await restarted.wake(0);
    assert.equal(replay.event.occurredAt, expected);
    assert.equal(replay.event.text, wake.event.text);
    assert.deepEqual(await restarted.inbox(), inbox);
    const forgedReplay = await restarted.control.accept({ token: "test", agent_id: "a", delivery_id: record!.delivery_id, event: record!.event });
    assert.equal(forgedReplay.state, "rejected"); assert.equal(forgedReplay.code, "delivery_conflict");
    await restarted.complete(0);
  });
}
