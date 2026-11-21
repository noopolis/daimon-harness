import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { parseOrganizationRuntimeConfig, type OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { createScheduleController, isCanonicalScheduleDeliveryId, isCurrentDreamOccurrence, type ScheduledOccurrence } from "./schedule.js";

const every = { kind: "every", interval_ms: 60_000, prompt: "work" } as const;
const disabled = { kind: "disabled" } as const;
const memory = { runtimeHomePath: "/memory/alpha", source: "alpha", dreamSchedule: every };
const agent = { id: "alpha", name: "Alpha", instructions: "work", workspacePath: "/workspace/alpha", runtimeHomePath: "/home/alpha", engine: { kind: "codex" }, schedule: every, memory } as const;
const workKey = "fb44b4fa9e74c61120d081ba3a608fb4e3a9f3aec1b97b7ee48c9111749540a3";
const stateFile = "schedule-state.v1.json";

test("matching work and dream schedules coalesce separately and survive restart", async (context) => {
  const fixture = await schedulerFixture(context);
  const busy = await fixture.start(agent, () => false);
  fixture.advance(61_000);
  await busy.drain();
  fixture.advance(181_000);
  await busy.drain();
  await busy.stop();

  const stored = Object.values((await fixture.read()).schedules);
  assert.equal(stored.length, 2);
  assert.equal(stored.every((entry) => entry.next_due_ms === 240_000), true);

  const received: ScheduledOccurrence[] = [];
  const replacement = await fixture.start(agent, (occurrence) => {
    received.push(occurrence);
    return occurrence.dream !== true;
  });
  assert.equal(received.length, 2);
  const [work, dream] = received;
  assert.deepEqual(work, { agentId: "alpha", deliveryId: `schedule:${workKey}:1970-01-01T00:03:00.000Z`, occurredAt: "1970-01-01T00:03:00.000Z", prompt: "work" });
  assert.equal(dream!.dream, true);
  assert.equal(dream!.occurredAt, work!.occurredAt);
  assert.equal(dream!.prompt, work!.prompt);
  assert.notEqual(dream!.deliveryId, work!.deliveryId);
  assert.equal(isCanonicalScheduleDeliveryId(dream!.deliveryId), true);
  assert.equal(isCurrentDreamOccurrence(agent, dream!.deliveryId, dream!.occurredAt, dream!.prompt), true);
  assert.equal(isCurrentDreamOccurrence(agent, dream!.deliveryId, dream!.occurredAt, "Changed maintenance request"), false);
  assert.equal(isCurrentDreamOccurrence(agent, work!.deliveryId, work!.occurredAt, work!.prompt), false);
  assert.equal(isCurrentDreamOccurrence(agent, dream!.deliveryId, "1970-01-01T00:03:00Z", dream!.prompt), false);
  await replacement.stop();

  const pending: ScheduledOccurrence[] = [];
  const final = await fixture.start(agent, (occurrence) => { pending.push(occurrence); });
  await final.drain(agent.id);
  assert.deepEqual(pending, [dream]);
});

test("busy work and dream schedules take turns across restart, timer and idle drains", async (context) => {
  const fixture = await schedulerFixture(context);
  const admitted: string[] = [];
  let busy = false;
  const accept = (occurrence: ScheduledOccurrence) => {
    if (busy) return false;
    admitted.push(`${occurrence.dream === true ? "dream" : "work"}:${Date.parse(occurrence.occurredAt)}`);
    busy = true;
    return true;
  };
  const first = await fixture.start(agent, accept);
  fixture.advance(60_000);
  await first.drain("unrelated-agent");
  assert.deepEqual(admitted, ["work:60000"]);
  fixture.advance(181_000);
  await first.drain("unrelated-agent");
  await first.stop();

  busy = false;
  const replacement = await fixture.start(agent, accept);
  assert.deepEqual(admitted, ["work:60000", "dream:180000"]);
  fixture.advance(241_000);
  await replacement.drain("unrelated-agent");
  busy = false;
  fixture.advance(301_000);
  await replacement.drain("unrelated-agent");
  assert.deepEqual(admitted, ["work:60000", "dream:180000", "work:300000"]);
  fixture.advance(361_000);
  await replacement.drain("unrelated-agent");
  busy = false;
  fixture.advance(421_000);
  await replacement.drain("unrelated-agent");
  assert.deepEqual(admitted, ["work:60000", "dream:180000", "work:300000", "dream:420000"]);
  fixture.advance(482_000);
  await replacement.drain("unrelated-agent");
  busy = false;
  await replacement.drain(agent.id);
  assert.deepEqual(admitted, ["work:60000", "dream:180000", "work:300000", "dream:420000", "work:480000"]);
});

test("adding a dream schedule preserves pending work from the previous state format", async (context) => {
  const fixture = await schedulerFixture(context);
  const occurredAt = "1970-01-01T00:01:00.000Z";
  const work = { agentId: "alpha", deliveryId: `schedule:${workKey}:${occurredAt}`, occurredAt, prompt: "work" };
  await fixture.write({ version: "noopolis.daimon.schedule-state.v1", schedules: { [workKey]: { next_due_ms: 120_000, latest_pending: work } } });
  fixture.advance(61_000);
  const received: ScheduledOccurrence[] = [];
  await fixture.start(agent, (occurrence) => { received.push(occurrence); });
  assert.deepEqual(received, [work]);
  assert.equal(Object.keys((await fixture.read()).schedules).length, 2);
});

test("valid multi-agent schedules persist pending state larger than the old cap", async (context) => {
  const fixture = await schedulerFixture(context);
  const schedule = { ...every, prompt: "🦉".repeat(3_600) };
  const { agents } = parseOrganizationRuntimeConfig({
    version: "noopolis.daimon.organization-runtime.v2",
    host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_TOKEN" },
    agents: Array.from({ length: 10 }, (_, index) => ({
      ...agent, id: `agent-${index}`, workspacePath: `/workspace/agent-${index}`, runtimeHomePath: `/home/agent-${index}`,
      schedule, memory: { runtimeHomePath: `/memory/agent-${index}`, dreamSchedule: schedule }
    }))
  });
  const first = await fixture.start(agents, () => false);
  await first.stop();
  fixture.advance(61_000);
  const busy = await fixture.start(agents, () => false);
  await busy.stop();
  const persisted = await fixture.read();
  assert.equal(Object.values(persisted.schedules).filter((entry) => entry.latest_pending !== undefined).length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(persisted), "utf8") > 256 * 1024);

  const received: ScheduledOccurrence[] = [];
  await fixture.start(agents, (occurrence) => { received.push(occurrence); });
  assert.equal(received.length, 20);
  assert.equal(received.filter((occurrence) => occurrence.dream === true).length, 10);
});

test("a memory bank change discards old dreams and leaves work intact", async (context) => {
  for (const changed of [{ ...memory, runtimeHomePath: "/memory/other" }, { ...memory, source: "other" }]) {
    await context.test(JSON.stringify(changed), async (subtest) => {
      const fixture = await schedulerFixture(subtest);
      const previous: ScheduledOccurrence[] = [];
      const first = await fixture.start(agent, (occurrence) => { previous.push(occurrence); return false; });
      fixture.advance(60_000);
      await first.drain();
      await first.stop();
      const oldDream = previous.find((occurrence) => occurrence.dream === true)!;
      const nextAgent = { ...agent, memory: changed };
      assert.equal(isCurrentDreamOccurrence(nextAgent, oldDream.deliveryId, oldDream.occurredAt, oldDream.prompt), false);

      const received: ScheduledOccurrence[] = [];
      const next = await fixture.start(nextAgent, (occurrence) => { received.push(occurrence); });
      assert.deepEqual(received, [previous.find((occurrence) => occurrence.dream === undefined)]);
      fixture.advance(120_000);
      await next.drain();
      const newDream = received.find((occurrence) => occurrence.dream === true)!;
      assert.equal(isCurrentDreamOccurrence(nextAgent, newDream.deliveryId, newDream.occurredAt, newDream.prompt), true);
      assert.equal(isCurrentDreamOccurrence(agent, newDream.deliveryId, newDream.occurredAt, newDream.prompt), false);
    });
  }
});

test("restored entries must match the schedule that created their dream marker", async (context) => {
  for (const [name, mutate] of [
    ["injected onto work", (state: State) => { state.schedules[workKey]!.latest_pending!.dream = true; }],
    ["removed from dream", (state: State) => { delete dreamEntry(state).latest_pending!.dream; }],
    ["invalid dream value", (state: State) => { dreamEntry(state).latest_pending!.dream = "true"; }],
    ["work identity with dream marker", (state: State) => { dreamEntry(state).latest_pending!.deliveryId = state.schedules[workKey]!.latest_pending!.deliveryId; }]
  ] as const) {
    await context.test(name, async (subtest) => {
      const fixture = await schedulerFixture(subtest);
      const first = await fixture.start(agent, () => false);
      fixture.advance(60_000);
      await first.drain();
      await first.stop();
      const state = await fixture.read();
      mutate(state);
      await fixture.write(state);

      const received: ScheduledOccurrence[] = [];
      await assert.rejects(fixture.start(agent, (occurrence) => { received.push(occurrence); }), /schedule state is invalid/u);
      assert.deepEqual(received, []);
    });
  }
});

test("dreams can run with work disabled and observe cron offset and minute", async (context) => {
  const fixture = await schedulerFixture(context);
  const first = "2026-10-25T00:30:00.000Z";
  const second = "2026-10-25T01:30:00.000Z";
  const cron = { kind: "cron", cron: "30 2 * * *", timezone: "Europe/Berlin", prompt: "reflect" } as const;
  const dreamAgent = { ...agent, schedule: disabled, memory: { ...memory, dreamSchedule: cron } };
  const received: ScheduledOccurrence[] = [];
  fixture.advance(Date.parse(first) - 60_000);
  const controller = await fixture.start(dreamAgent, (occurrence) => { received.push(occurrence); });
  fixture.advance(Date.parse(first));
  await controller.drain();
  fixture.advance(Date.parse(second));
  await controller.drain();
  assert.deepEqual(received.map((occurrence) => occurrence.occurredAt), [first, second]);
  assert.equal(received.every((occurrence) => occurrence.dream === true && isCurrentDreamOccurrence(dreamAgent, occurrence.deliveryId, occurrence.occurredAt, occurrence.prompt)), true);
  assert.notEqual(received[0]!.deliveryId, received[1]!.deliveryId);
  assert.equal(isCurrentDreamOccurrence(dreamAgent, received[0]!.deliveryId, "2026-10-25T00:30:10.000Z", cron.prompt), false);
  assert.equal(isCurrentDreamOccurrence({ ...dreamAgent, memory: { ...memory, dreamSchedule: disabled } }, received[0]!.deliveryId, first, cron.prompt), false);
});

type State = { version: string; schedules: Record<string, { next_due_ms: number; latest_pending?: Record<string, unknown> }> };

function dreamEntry(state: State) {
  return Object.values(state.schedules).find((entry) => entry.latest_pending?.dream === true)!;
}

async function schedulerFixture(context: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dream-schedule-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const file = path.join(root, stateFile);
  type FakeTimer = { due: number; unref(): void };
  const timers = new Map<FakeTimer, () => void>();
  let now = 0;
  return {
    read: async () => JSON.parse(await readFile(file, "utf8")) as State,
    write: (state: State) => writeFile(file, JSON.stringify(state), { mode: 0o600 }),
    advance: (at: number) => {
      now = at;
      for (const [timer, callback] of [...timers]) {
        if (timer.due > now) continue;
        timers.delete(timer);
        callback();
      }
    },
    start: async (config: OrganizationRuntimeAgentConfig | readonly OrganizationRuntimeAgentConfig[], accept: (occurrence: ScheduledOccurrence) => boolean | void) => {
      const controller = createScheduleController({ acceptanceStorePath: root, agents: "id" in config ? [config] : config, accept: async (occurrence) => accept(occurrence), now: () => now,
        setTimer: (callback, delay) => {
          const timer = { due: now + delay, unref() {} };
          timers.set(timer, callback);
          return timer as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: (timer) => { timers.delete(timer as unknown as FakeTimer); }
      });
      context.after(() => controller.stop());
      await controller.start();
      return controller;
    }
  };
}
