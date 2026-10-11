import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createScheduleController, jitterOffsetMs, MAX_TIMER_DELAY_MS, nextOccurrence, occurrenceFor } from "./schedule.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

const every = { kind: "every" as const, interval_ms: 60_000, prompt: "work" };
const agent = (schedule: typeof every | { kind: "every"; interval_ms: number; prompt: string; jitter_seconds?: number } | { kind: "cron"; cron: string; timezone: string; prompt: string; jitter_seconds?: number } | { kind: "disabled" }) =>
  ({ id: "alpha", name: "Alpha", instructions: "work", workspacePath: "/workspace/alpha", runtimeHomePath: "/home/alpha", engine: { kind: "codex" as const }, schedule });

test("every schedules keep a stable anchor and coalesce downtime to the latest cadence", () => {
  assert.equal(nextOccurrence("alpha", every, 0, 305_000), 360_000);
  assert.equal(nextOccurrence("alpha", every, 0, 59_000), 60_000);
});

test("cron field origins, impossible dates, and sparse leap work are deterministic", () => {
  const stepped = { kind: "cron" as const, cron: "0 0 */2 */2 *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", stepped, undefined, Date.parse("2026-01-01T00:00:00.000Z")), Date.parse("2026-01-03T00:00:00.000Z"));
  const leap = { kind: "cron" as const, cron: "0 0 29 2 *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", leap, undefined, Date.parse("2025-03-01T00:00:00.000Z")), Date.parse("2028-02-29T00:00:00.000Z"));
  assert.throws(() => nextOccurrence("alpha", { ...leap, cron: "0 0 31 2 *" }, undefined, 0), /impossible/);
});

test("cron forward search chooses the immediately next minute from a partial minute", () => {
  const schedule = { kind: "cron" as const, cron: "* * * * *", timezone: "UTC", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-01-01T00:00:30.500Z")), Date.parse("2026-01-01T00:01:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "  *   *  * *   * " }, undefined, Date.parse("2026-01-01T00:00:30.500Z")), Date.parse("2026-01-01T00:01:00.000Z"));
  assert.throws(() => nextOccurrence("alpha", { ...schedule, cron: `*/${"9".repeat(400)} * * * *` }, undefined, 0), /invalid/);
});

test("cron occurrence identities include the named-zone offset across DST fall-back", () => {
  const schedule = { kind: "cron" as const, cron: "30 2 * * *", timezone: "Europe/Berlin", prompt: "work" };
  const first = occurrenceFor("alpha", schedule, Date.parse("2026-10-25T00:30:00.000Z"));
  const second = occurrenceFor("alpha", schedule, Date.parse("2026-10-25T01:30:00.000Z"));
  assert.notEqual(first.deliveryId, second.deliveryId);
});

test("cron skips nonexistent spring time and restart picks the second fall occurrence", () => {
  const schedule = { kind: "cron" as const, cron: "30 2 * * *", timezone: "Europe/Berlin", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-03-29T00:00:00.000Z")), Date.parse("2026-03-30T00:30:00.000Z"));
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-10-25T00:31:00.000Z")), Date.parse("2026-10-25T01:30:00.000Z"));
});

test("cron combines restricted day-of-month and day-of-week with standard OR semantics across DST", () => {
  const schedule = { kind: "cron" as const, cron: "0 0 1 * 1", timezone: "Europe/Berlin", prompt: "work" };
  assert.equal(nextOccurrence("alpha", schedule, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-29T22:00:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "0 0 * * 1" }, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-29T22:00:00.000Z"));
  assert.equal(nextOccurrence("alpha", { ...schedule, cron: "0 0 1 * *" }, undefined, Date.parse("2026-03-28T00:00:00.000Z")), Date.parse("2026-03-31T22:00:00.000Z"));
});

test("state remains inside the mounted root and replacement drains a missed occurrence once", async () => {
  const root = await privateRoot();
  let now = 0;
  const timers = fakeTimers();
  try {
    const first = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
    await first.start();
    assert.equal((await stat(path.join(root, "schedule-state.v1.json"))).mode & 0o777, 0o600);
    await first.stop();
    now = 181_000;
    const accepted: ReturnType<typeof occurrenceFor>[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => { accepted.push(occurrence); }, now: () => now, ...fakeTimers().options });
    await replacement.start(); await replacement.stop();
    assert.deepEqual(accepted, [occurrenceFor("alpha", every, 180_000)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("every cadence samples now once and persists the immediate next 1ms occurrence", async () => {
  const root = await privateRoot(); const oneMs = { ...every, interval_ms: 1 }; let tick = 0;
  try {
    await seedState(root, oneMs, 1);
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(oneMs)], accept: async () => false, now: () => ++tick, ...fakeTimers().options });
    await controller.start(); await controller.stop();
    const state = JSON.parse(await readState(root)); const entry = state.schedules[Object.keys(state.schedules)[0]];
    assert.equal(entry.next_due_ms, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("state persistence orders write, file sync, rename, and directory sync", async () => {
  const root = await privateRoot(); const stages: string[] = [];
  try {
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => 0, onPersistStageForTest: (stage) => stages.push(stage), ...fakeTimers().options });
    await controller.start(); await controller.stop();
    assert.deepEqual(stages, ["write", "file-sync", "rename", "directory-sync"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("busy fires durably replace latest pending and restart drains only the newest", async () => {
  const root = await privateRoot(); let now = 0; const timers = fakeTimers();
  try {
    const busy = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
    await busy.start();
    now = 61_000; timers.fire();
    await eventually(async () => {
      const value = JSON.parse(await readState(root)); const entry = value.schedules[Object.keys(value.schedules)[0]];
      return entry?.latest_pending?.occurredAt === new Date(60_000).toISOString();
    });
    now = 121_000; timers.fire();
    await eventually(async () => (await readState(root)).includes(new Date(120_000).toISOString()));
    await busy.stop();
    const accepted: ReturnType<typeof occurrenceFor>[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => { accepted.push(occurrence); }, now: () => now, ...fakeTimers().options });
    await replacement.start();
    await Promise.all([replacement.drain("alpha"), replacement.drain("alpha")]);
    await replacement.stop();
    assert.deepEqual(accepted, [occurrenceFor("alpha", every, 120_000)]);
    assert.equal((await readdir(root)).some((file) => file.startsWith(".schedule-state-")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restored pending work is bound to its exact agent, schedule, identity, and due time", async (context) => {
  for (const [name, mutate] of [
    ["agent", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.agentId = "beta"; }],
    ["prompt", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.prompt = "rerouted"; }],
    ["delivery", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.deliveryId = `${pending.deliveryId as string}:changed`; }],
    ["timestamp", (pending: Record<string, unknown>, _entry: Record<string, unknown>) => { pending.occurredAt = new Date(61_000).toISOString(); }],
    ["due", (_pending: Record<string, unknown>, entry: Record<string, unknown>) => { entry.next_due_ms = 180_000; }]
  ] as const) {
    await context.test(name, async () => {
      const root = await privateRoot(); const timers = fakeTimers(); let now = 0;
      try {
        const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => now, ...timers.options });
        await controller.start(); now = 61_000; timers.fire();
        await eventually(async () => (await readState(root)).includes("latest_pending"));
        await controller.stop();
        const state = JSON.parse(await readState(root)) as { schedules: Record<string, Record<string, unknown>> };
        const entry = state.schedules[Object.keys(state.schedules)[0]!]!;
        mutate(entry.latest_pending as Record<string, unknown>, entry);
        await writeFile(path.join(root, "schedule-state.v1.json"), JSON.stringify(state), { mode: 0o600 });
        const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => true, now: () => now, ...fakeTimers().options });
        await assert.rejects(replacement.start(), /schedule state is invalid/);
        await replacement.stop();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
});

test("timers above Node's maximum are armed in bounded chunks", async () => {
  const root = await privateRoot(); const delays: number[] = [];
  try {
    const controller = createScheduleController({
      acceptanceStorePath: root, agents: [agent({ ...every, interval_ms: 31_536_000_000 })], accept: async () => undefined, now: () => 0,
      setTimer: ((callback: () => void, delay: number) => { delays.push(delay); return { callback, unref() {} } as never; }), clearTimer: () => undefined
    });
    await controller.start(); await controller.stop();
    assert.deepEqual(delays, [MAX_TIMER_DELAY_MS]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("disabled schedules persist no pending work", async () => {
  const root = await privateRoot(); const accepted: unknown[] = [];
  try {
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent({ kind: "disabled" })], accept: async (value) => { accepted.push(value); } });
    await controller.start(); await controller.stop(); assert.deepEqual(accepted, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-acceptance cut deduplicates one stable occurrence on a fresh replacement", async () => {
  const root = await privateRoot(); const now = 61_000; const storeOptions = {
    processIdentity: async () => ({ pid: 1, process_start: "schedule-test", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }),
    ownerLiveness: async () => true
  };
  try {
    await seedState(root, every, 60_000);
    const firstStore = await WakeAcceptanceStore.open(root, storeOptions);
    let durableAcceptanceId: string | undefined;
    const crash = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => {
      const accepted = await firstStore.accept(scheduleRequest(occurrence));
      assert.equal(accepted.created, true); durableAcceptanceId = accepted.record.acceptance_id;
      throw new Error("forced post-acceptance cut");
    }, now: () => now, ...fakeTimers().options });
    await assert.rejects(crash.start(), /forced post-acceptance cut/); await crash.stop(); await firstStore.close();

    const replacementStore = await WakeAcceptanceStore.open(root, storeOptions);
    const drained: string[] = [];
    const replacement = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async (occurrence) => {
      drained.push(occurrence.deliveryId);
      const duplicate = await replacementStore.accept(scheduleRequest(occurrence));
      assert.equal(duplicate.created, false); assert.equal(duplicate.record.acceptance_id, durableAcceptanceId);
      return true;
    }, now: () => now, ...fakeTimers().options });
    await replacement.start(); await replacement.drain("alpha"); await replacement.stop();
    assert.deepEqual(drained, [occurrenceFor("alpha", every, 60_000).deliveryId]);
    assert.equal((await replacementStore.recoverable(new Set(["alpha"]))).length, 1);
    assert.equal((await readState(root)).includes("latest_pending"), false);
    await replacementStore.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("jitter offset stays within [0, jitter_seconds * 1000] and zero/absent jitter is always exactly 0", () => {
  const jittered = { ...every, jitter_seconds: 10 };
  for (const draw of [0, 0.25, 0.5, 0.75, 0.999_999_999]) {
    const offset = jitterOffsetMs(jittered, () => draw);
    assert.ok(offset >= 0 && offset <= 10_000, `offset ${offset} out of bounds for draw ${draw}`);
  }
  assert.equal(jitterOffsetMs(jittered, () => 0), 0);
  assert.equal(jitterOffsetMs(jittered, () => 0.999_999_999), 10_000);
  assert.equal(jitterOffsetMs(every, () => 0.999_999_999), 0);
  assert.equal(jitterOffsetMs({ ...every, jitter_seconds: 0 }, () => 0.999_999_999), 0);
  const cronJittered = { kind: "cron" as const, cron: "0 10 * * *", timezone: "Europe/Berlin", prompt: "work", jitter_seconds: 900 };
  assert.equal(jitterOffsetMs(cronJittered, () => 0), 0);
  assert.equal(jitterOffsetMs(cronJittered, () => 0.999_999_999), 900_000);
});

test("jitter offsets drawn independently per firing differ across firings and never accumulate onto the true cron instant", async () => {
  const root = await privateRoot();
  const cron = { kind: "cron" as const, cron: "* * * * *", timezone: "UTC", prompt: "work", jitter_seconds: 30 };
  let now = 0;
  const draws = [0, 0.5, 0.999_999_999, 0.25];
  let drawIndex = 0;
  const random = () => draws[drawIndex++ % draws.length]!;
  const delays: number[] = [];
  let latest: (() => void) | undefined;
  const setTimer = ((callback: () => void, delay: number) => { delays.push(delay); latest = callback; return { unref() {} } as never; });
  const clearTimer = () => undefined;
  try {
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(cron)], accept: async () => undefined, now: () => now, random, setTimer, clearTimer });
    await controller.start();
    assert.equal(delays[0], 60_000); // due 60_000 + offset 0
    now = 60_000; latest?.();
    await eventually(async () => delays.length === 2);
    assert.equal(delays[1], 60_000 + 15_000); // due 120_000, fire target 135000
    now = 135_000; latest?.();
    await eventually(async () => delays.length === 3);
    assert.equal(delays[2], 45_000 + 30_000); // due 180_000, fire target 210000
    now = 210_000; latest?.();
    await eventually(async () => delays.length === 4);
    assert.equal(delays[3], 30_000 + 7_500); // due 240_000, fire target 247500
    now = 247_500; latest?.();
    await eventually(async () => {
      const value = JSON.parse(await readState(root));
      return value.schedules[Object.keys(value.schedules)[0]!].next_due_ms === 300_000;
    });
    // The persisted next_due_ms sequence stays locked to the exact per-minute cron
    // cadence throughout — 60000, 120000, 180000, 240000, 300000 — never the jittered
    // fire times, so per-firing jitter never accumulates onto the true instant.
    const state = JSON.parse(await readState(root));
    const entry = state.schedules[Object.keys(state.schedules)[0]!];
    assert.equal(entry.next_due_ms, 300_000);
    await controller.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("absent jitter_seconds produces byte-identical delay to the un-jittered schedule", async () => {
  const root = await privateRoot();
  const delays: number[] = [];
  try {
    const controller = createScheduleController({
      acceptanceStorePath: root, agents: [agent(every)], accept: async () => undefined, now: () => 0, random: () => 0.999_999_999,
      setTimer: ((callback: () => void, delay: number) => { delays.push(delay); return { unref() {} } as never; }), clearTimer: () => undefined
    });
    await controller.start(); await controller.stop();
    assert.deepEqual(delays, [60_000]); // no jitter_seconds on `every`: identical to today regardless of the random draw
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("restart inside a jitter window neither fires early nor drifts the persisted due time", async () => {
  const root = await privateRoot();
  const jittered = { ...every, jitter_seconds: 30 };
  let now = 0;
  try {
    const first = createScheduleController({ acceptanceStorePath: root, agents: [agent(jittered)], accept: async () => { throw new Error("must not fire before due"); }, now: () => now, random: () => 0.5, ...fakeTimers().options });
    await first.start();
    const before = JSON.parse(await readState(root));
    const dueBefore = before.schedules[Object.keys(before.schedules)[0]!].next_due_ms;
    const fireBefore = before.schedules[Object.keys(before.schedules)[0]!].fire_at_ms;
    assert.equal(dueBefore, 60_000); // true cadence instant, unaffected by jitter
    assert.equal(fireBefore, 75_000);
    now = 61_000; // past the due instant, still inside the jitter delay
    await first.stop();

    const restarted = createScheduleController({ acceptanceStorePath: root, agents: [agent(jittered)], accept: async () => { throw new Error("must not fire before the jittered target"); }, now: () => now, random: () => 0.9, ...fakeTimers().options });
    await restarted.start();
    const after = JSON.parse(await readState(root));
    const dueAfter = after.schedules[Object.keys(after.schedules)[0]!].next_due_ms;
    const fireAfter = after.schedules[Object.keys(after.schedules)[0]!].fire_at_ms;
    assert.equal(dueAfter, dueBefore, "restart inside the jitter window must not drift the persisted due time");
    assert.equal(fireAfter, fireBefore, "restart inside the jitter window must preserve the already drawn fire target");
    await restarted.stop();

    now = 75_000;
    const accepted: unknown[] = [];
    const timers = fakeTimers();
    const finalRun = createScheduleController({ acceptanceStorePath: root, agents: [agent(jittered)], accept: async (occurrence) => { accepted.push(occurrence); }, now: () => now, random: () => 0.5, ...timers.options });
    await finalRun.start();
    await eventually(async () => accepted.length === 1);
    await finalRun.stop();
    assert.deepEqual(accepted, [occurrenceFor("alpha", jittered, 60_000)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function privateRoot(): Promise<string> { const root = await mkdtemp(path.join(os.tmpdir(), "daimon-schedule-")); await chmod(root, 0o700); return root; }
async function readState(root: string): Promise<string> { return await import("node:fs/promises").then(({ readFile }) => readFile(path.join(root, "schedule-state.v1.json"), "utf8")); }
test("restored schedule timestamps cover years 1970 through 9999 and reject invalid instants", async () => {
  const minimum = Date.parse("1970-01-01T00:00:00.000Z"), maximum = Date.parse("9999-12-31T23:59:59.999Z");
  for (const due of [minimum, -1, 0, maximum, minimum - 1, maximum + 1, Number.MAX_SAFE_INTEGER, 1.5]) {
    const root = await privateRoot();
    await seedState(root, every, due);
    const controller = createScheduleController({ acceptanceStorePath: root, agents: [agent(every)], accept: async () => false, now: () => Math.max(0, due - 1), ...fakeTimers().options });
    try {
      if ([minimum, 0, maximum].includes(due)) await controller.start();
      else await assert.rejects(controller.start(), /schedule state is invalid/u);
    } finally { await controller.stop(); await rm(root, { recursive: true, force: true }); }
  }
});

async function seedState(root: string, schedule: typeof every, due: number): Promise<void> {
  const key = occurrenceFor("alpha", schedule, 0).deliveryId.split(":")[1]!;
  await writeFile(path.join(root, "schedule-state.v1.json"), JSON.stringify({ version: "noopolis.daimon.schedule-state.v1", schedules: { [key]: { next_due_ms: due } } }), { mode: 0o600 });
}
function scheduleRequest(occurrence: ReturnType<typeof occurrenceFor>) {
  return parseWakeAcceptanceRequest({ token: undefined, agent_id: occurrence.agentId, delivery_id: occurrence.deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "schedule", text: occurrence.prompt, occurred_at: occurrence.occurredAt } });
}
function fakeTimers(): { options: { setTimer: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>; clearTimer: (timer: ReturnType<typeof setTimeout>) => void }; fire(): void } {
  let latest: (() => void) | undefined;
  return { options: { setTimer: ((callback: () => void) => { latest = callback; return { unref() {} } as never; }), clearTimer: () => undefined }, fire: () => latest?.() };
}
async function eventually(predicate: () => Promise<boolean>): Promise<void> { const end = Date.now() + 2_000; while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw new Error("timed out"); }
