import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { attentionTools, type AttentionMessage, type AttentionRegistry } from "./attention.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";

const realAnchor = Date.parse("2026-10-11T12:00:00Z");
async function fixture(t: TestContext, origin: string, timezone: string, cron: string, clocked = true, intervalMs?: number) {
  const previous = process.env;
  process.env = { ...previous, CLOCK_TEST_TOKEN: "test" };
  if (clocked) process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin, anchorEpochMs: realAnchor });
  else delete process.env.NOOPOLIS_TASK_CLOCK;
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-cron-clock-"));
  let realNow = realAnchor;
  const controls: ReturnType<typeof createOrganizationRuntimeControlHostWithCoreForTest>[] = [];
  t.after(async () => { for (const control of controls) await control.stop(); process.env = previous; await rm(root, { recursive: true, force: true }); });
  const schedule = intervalMs === undefined ? { kind: "cron", cron, timezone, prompt: "work" } : { kind: "every", interval_ms: intervalMs, prompt: "work" };
  const config = { version: "noopolis.daimon.organization-runtime.v2", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CLOCK_TEST_TOKEN" }, agents: [{ id: "a", name: "A", instructions: "test", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "home"), engine: { kind: "codex" }, attention: {}, schedule }] };
  return {
    advance(ms: number) { realNow += ms; },
    async start() {
      let timer!: () => void, delay = -1;
      let deliver!: (message: AttentionMessage) => void;
      const delivered = new Promise<AttentionMessage>((resolve) => { deliver = resolve; });
      const registry: AttentionRegistry = new Map();
      const core = createOrganizationRuntimeHostForTest(config, async () => ({ id: "a", status: () => ({ agentId: "a", state: "idle" }), stop: async () => {}, wake: async () => {
        const tools = attentionTools("a", registry);
        const inbox = (await tools[0]!.execute("read", {}, undefined, undefined, {} as never)).details as { messages: AttentionMessage[] };
        const message = inbox.messages[0]!;
        await tools[1]!.execute("complete", { delivery_id: message.delivery_id, disposition: "complete" }, undefined, undefined, {} as never);
        deliver(message);
        return { agentId: "a", text: "", durationMs: 0 };
      } }));
      const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, {
        acceptanceStorePath: root, controlToken: "test", attentionRegistryForTest: registry,
        storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true },
        scheduleOptions: { now: () => realNow, setTimer: (callback, milliseconds) => { timer = callback; delay = milliseconds; return { unref() {} } as NodeJS.Timeout; }, clearTimer() {} }
      });
      controls.push(control);
      await control.start();
      return {
        control, delivered, delay: () => delay, fire: () => timer(),
        async nextDue() { const state = JSON.parse(await readFile(path.join(root, "schedule-state.v1.json"), "utf8")); return (Object.values(state.schedules)[0] as { next_due_ms: number }).next_due_ms; }
      };
    }
  };
}

for (const scenario of [
  { name: "reviewer 08:59 to 09:00", origin: "2024-02-29T08:59:00Z", zone: "UTC", cron: "0 9 * * *", due: "2024-02-29T09:00:00.000Z", suffix: "2024-02-29T09:00@GMT" },
  { name: "named timezone", origin: "2024-02-29T07:59:00Z", zone: "Europe/Berlin", cron: "0 9 * * *", due: "2024-02-29T08:00:00.000Z", suffix: "2024-02-29T09:00@GMT+01:00" },
  { name: "spring DST gap", origin: "2024-03-31T00:59:00Z", zone: "Europe/Berlin", cron: "30 2 * * *", due: "2024-04-01T00:30:00.000Z", suffix: "2024-04-01T02:30@GMT+02:00" }
]) {
  test(`task-calendar cron: ${scenario.name}`, { timeout: 5000 }, async (t) => {
    const rig = await fixture(t, scenario.origin, scenario.zone, scenario.cron);
    const host = await rig.start();
    const expectedDelay = Date.parse(scenario.due) - Date.parse(scenario.origin);
    assert.equal(host.delay(), expectedDelay);
    assert.equal(await host.nextDue(), Date.parse(scenario.due));
    rig.advance(expectedDelay); host.fire();
    const message = await host.delivered;
    assert.equal(message.occurred_at, scenario.due);
    assert.ok(message.delivery_id.endsWith(`:${scenario.suffix}`) || scenario.zone === "UTC" && message.delivery_id.endsWith(`:${scenario.suffix}+00:00`));
    assert.doesNotMatch(message.delivery_id, /2026-10-11/u);
    assert.equal((await host.control.wakeReceipt("test", message.acceptance_id))!.state, "completed", "the visible schedule ID must resolve disposition");
  });
}

test("restart preserves task-calendar state and original anchor across repeated DST hour", { timeout: 5000 }, async (t) => {
  const rig = await fixture(t, "2024-10-27T00:29:00Z", "Europe/Berlin", "30 2 * * *");
  const first = await rig.start();
  assert.equal(first.delay(), 60000);
  rig.advance(60000); first.fire();
  const earlier = await first.delivered;
  await first.control.stop();
  rig.advance(30 * 60000);
  const second = await rig.start();
  assert.equal(second.delay(), 30 * 60000);
  assert.equal(await second.nextDue(), Date.parse("2024-10-27T01:30:00Z"));
  rig.advance(30 * 60000); second.fire();
  const later = await second.delivered;
  assert.equal(earlier.occurred_at, "2024-10-27T00:30:00.000Z");
  assert.equal(later.occurred_at, "2024-10-27T01:30:00.000Z");
  assert.ok(earlier.delivery_id.endsWith("@GMT+02:00"));
  assert.ok(later.delivery_id.endsWith("@GMT+01:00"));
  assert.notEqual(earlier.delivery_id, later.delivery_id);
});

test("unset clock still selects the real calendar occurrence", async (t) => {
  const rig = await fixture(t, "2024-02-29T08:59:00Z", "UTC", "0 9 * * *", false);
  const host = await rig.start();
  assert.equal(host.delay(), 21 * 3600000);
  assert.equal(await host.nextDue(), Date.parse("2026-10-12T09:00:00Z"));
});

for (const kind of ["cron", "every"] as const) {
  test(`1970 boundary task origin restarts ${kind} schedules`, { timeout: 5000 }, async (t) => {
    const rig = await fixture(t, "1970-01-01T00:00:00Z", "UTC", "* * * * *", true, kind === "every" ? 60_000 : undefined);
    const first = await rig.start();
    assert.equal(first.delay(), 60_000);
    assert.equal(await first.nextDue(), Date.parse("1970-01-01T00:01:00Z"));
    await first.control.stop();
    rig.advance(30_000);
    const second = await rig.start();
    assert.equal(second.delay(), 30_000);
    assert.equal(await second.nextDue(), Date.parse("1970-01-01T00:01:00Z"));
    rig.advance(30_000); second.fire();
    const occurrence = await second.delivered;
    assert.equal(occurrence.occurred_at, "1970-01-01T00:01:00.000Z");
    assert.match(occurrence.delivery_id, /:1970-01-01T00:01/u);
    assert.equal((await second.control.wakeReceipt("test", occurrence.acceptance_id))!.state, "completed");
    await second.control.stop();
    const third = await rig.start();
    assert.equal(third.delay(), 60_000);
    assert.equal(await third.nextDue(), Date.parse("1970-01-01T00:02:00Z"));
  });
}
