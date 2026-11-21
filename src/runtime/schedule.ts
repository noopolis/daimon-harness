import { assertTaskInstant, validTaskInstant } from "./taskClock.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ORGANIZATION_RUNTIME_MAX_AGENTS, ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES } from "../contracts/organizationRuntimeContract.js";

import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

import { DREAM_DELIVERY_PREFIX, dreamSlot, workScheduleKey, isCanonicalScheduleDeliveryId, type ActiveSchedule, type ScheduleSlot } from "./scheduleSlots.js";
export { isCanonicalScheduleDeliveryId } from "./scheduleSlots.js";

const STATE_VERSION = "noopolis.daimon.schedule-state.v1" as const;
const STATE_FILE = "schedule-state.v1.json";
// State reuses the encoded prompts and repeats each agent ID at most twice.
// Each slot can add 512 bytes for its key, delivery ID, timestamps and other fields.
const MAX_STATE_BYTES = 2 * ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES + 2 * ORGANIZATION_RUNTIME_MAX_AGENTS * 512;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SEARCH_HORIZON_MS = 64 * 366 * 86_400_000;
const MAX_SEARCH_CHECKS = 1_000_000;
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export type ScheduledOccurrence = Readonly<{ agentId: string; deliveryId: string; occurredAt: string; prompt: string; dream?: true }>;
type Entry = Readonly<{ next_due_ms: number; fire_at_ms?: number; latest_pending?: ScheduledOccurrence; prefer_dream?: true }>;
type State = Readonly<{ version: typeof STATE_VERSION; schedules: Record<string, Entry> }>;
type Timer = ReturnType<typeof setTimeout>;

export type ScheduleController = Readonly<{ start(): Promise<void>; drain(agentId?: string): Promise<void>; stop(): Promise<void> }>;
export type ScheduleControllerOptions = Readonly<{
  acceptanceStorePath: string;
  agents: readonly OrganizationRuntimeAgentConfig[];
  /** False means the agent is busy; the durable latest-pending slot remains. */
  accept(occurrence: ScheduledOccurrence): Promise<boolean | void>;
  now?: () => number;
  /** Draws the fractional jitter offset; defaults to `Math.random`. Injectable so tests can assert bounds/independence without real randomness. */
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  /** @internal Observable durability stages for focused crash-order tests. */
  onPersistStageForTest?: (stage: "write" | "file-sync" | "rename" | "directory-sync") => void;
}>;

/** Schedules create durable pending occurrences; engine execution remains elsewhere. */
export function createScheduleController(options: ScheduleControllerOptions): ScheduleController {
  const now = () => assertTaskInstant((options.now ?? Date.now)());
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const statePath = path.join(options.acceptanceStorePath, STATE_FILE);
  const byKey = new Map<string, ScheduleSlot>();
  const byAgent = new Map<string, { work?: string; dream?: string }>();
  for (const agent of options.agents) {
    const schedule = agent.schedule;
    const keys: { work?: string; dream?: string } = {};
    if (schedule !== undefined && schedule.kind !== "disabled") {
      const key = workScheduleKey(agent.id, schedule);
      byKey.set(key, { agentId: agent.id, schedule, key });
      keys.work = key;
    }
    const dream = dreamSlot(agent);
    if (dream !== undefined) { byKey.set(dream.key, dream); keys.dream = dream.key; }
    if (keys.work !== undefined || keys.dream !== undefined) byAgent.set(agent.id, keys);
  }
  const timers = new Map<string, Timer>();
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  let state: State = { version: STATE_VERSION, schedules: {} };
  let mutations: Promise<void> = Promise.resolve();
  let stopped = false;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutations.catch(() => undefined).then(operation);
    mutations = result.then(() => undefined, () => undefined);
    return result;
  };
  const save = async (): Promise<void> => {
    if (directory === undefined) throw new Error("schedule state directory is unavailable");
    await persist(statePath, state, directory, options.onPersistStageForTest);
  };
  const nextEntry = (slot: ScheduleSlot, anchor: number | undefined, observedNow: number, latest_pending?: ScheduledOccurrence, prefer_dream?: true): Entry => {
    const next_due_ms = nextOccurrence(slot.agentId, slot.schedule, anchor, observedNow);
    return withFireTarget({ next_due_ms, ...(latest_pending === undefined ? {} : { latest_pending }), ...(prefer_dream === undefined ? {} : { prefer_dream }) }, slot.schedule, random);
  };
  const elapsedEntry = (slot: ScheduleSlot, entry: Entry, observedNow: number): Entry => {
    const elapsed = latestEligibleOccurrence(slot.schedule, entry.next_due_ms, observedNow);
    const pending = newer(entry.latest_pending, slotOccurrence(slot, elapsed));
    return nextEntry(slot, elapsed, observedNow, pending, entry.prefer_dream);
  };
  const arm = (key: string): void => {
    const prior = timers.get(key);
    if (prior !== undefined) clearTimer(prior);
    if (stopped) return;
    const entry = state.schedules[key];
    if (entry === undefined) return;
    const target = entry.fire_at_ms ?? entry.next_due_ms;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, target - now()));
    const timer = setTimer(() => { void enqueue(async () => await onTimer(key)); }, delay);
    timer.unref?.();
    timers.set(key, timer);
  };
  const drainKey = async (key: string | undefined, pairedDreamKey: string | undefined): Promise<void> => {
    if (key === undefined || stopped) return;
    const pending = state.schedules[key]?.latest_pending;
    if (pending === undefined) return;
    const accepted = await options.accept(pending);
    if (accepted === false || stopped) return;
    const current = state.schedules[key];
    if (current?.latest_pending?.deliveryId !== pending.deliveryId) return;
    const { latest_pending, ...rest } = current;
    const next = { ...state.schedules, [key]: rest };
    if (pairedDreamKey !== undefined) {
      // Keep the cursor on the dream slot so ordinary schedule state stays compatible.
      const { prefer_dream, ...dream } = next[pairedDreamKey]!;
      next[pairedDreamKey] = key === pairedDreamKey ? dream : { ...dream, prefer_dream: true };
    }
    state = { ...state, schedules: next };
    await save();
  };
  const drainAgent = async (agentId: string): Promise<void> => {
    const slots = byAgent.get(agentId);
    if (slots === undefined) return;
    const { work, dream } = slots;
    const pair = work === undefined ? undefined : dream;
    const preferDream = pair !== undefined && state.schedules[pair]?.prefer_dream === true;
    await drainKey(preferDream ? dream : work, pair);
    await drainKey(preferDream ? work : dream, pair);
  };
  const onTimer = async (key: string): Promise<void> => {
    if (stopped) return;
    const slot = byKey.get(key); const entry = state.schedules[key];
    if (slot === undefined || entry === undefined) return;
    const observedNow = now();
    const fireAt = entry.fire_at_ms ?? entry.next_due_ms;
    if (fireAt > observedNow) { arm(key); return; }
    const { work, dream } = byAgent.get(slot.agentId)!;
    const next = { ...state.schedules };
    const due: string[] = [];
    // Coalesce both due slots before picking which pending occurrence to admit.
    for (const id of [work, dream]) {
      if (id === undefined) continue;
      const prior = next[id]!;
      if ((prior.fire_at_ms ?? prior.next_due_ms) > observedNow) continue;
      next[id] = elapsedEntry(byKey.get(id)!, prior, observedNow);
      due.push(id);
    }
    state = { ...state, schedules: next };
    await save();
    for (const id of due) arm(id);
    await drainAgent(slot.agentId);
  };

  return {
    async start(): Promise<void> {
      await enqueue(async () => {
        if (directory !== undefined) return;
        directory = await open(options.acceptanceStorePath, constants.O_RDONLY | directoryFlag() | noFollow());
        state = await restore(statePath, byKey);
        const next = { ...state.schedules };
        const observedNow = now();
        for (const [key, slot] of byKey) {
          const prior = next[key];
          if (prior === undefined) next[key] = nextEntry(slot, undefined, observedNow);
          else if ((prior.fire_at_ms ?? prior.next_due_ms) <= observedNow) {
            next[key] = elapsedEntry(slot, prior, observedNow);
          } else if (prior.fire_at_ms === undefined) {
            next[key] = withFireTarget(prior, slot.schedule, random);
          }
        }
        state = { version: STATE_VERSION, schedules: next };
        await save();
        for (const key of byKey.keys()) arm(key);
        for (const agentId of byAgent.keys()) await drainAgent(agentId);
      });
    },
    async drain(agentId?: string): Promise<void> {
      await enqueue(async () => {
        for (const id of agentId === undefined ? byAgent.keys() : [agentId]) await drainAgent(id);
      });
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear(); await mutations; await directory?.close(); directory = undefined;
    }
  };
}

export function occurrenceFor(agentId: string, schedule: ActiveSchedule, at: number): ScheduledOccurrence {
  return slotOccurrence({ agentId, schedule, key: workScheduleKey(agentId, schedule) }, at);
}

/** Validate an accepted native dream against the currently configured schedule and memory bank. */
export function isCurrentDreamOccurrence(agent: OrganizationRuntimeAgentConfig, deliveryId: string, occurredAt: string, prompt: string): boolean {
  const slot = dreamSlot(agent);
  const at = Date.parse(occurredAt);
  return slot !== undefined && slot.schedule.prompt === prompt && validTaskInstant(at) && new Date(at).toISOString() === occurredAt
    && matchesDreamInstant(slot.schedule, at) && slotOccurrence(slot, at).deliveryId === deliveryId;
}

function slotOccurrence({ agentId, schedule, key, dream }: ScheduleSlot, at: number): ScheduledOccurrence {
  assertTaskInstant(at);
  const local = schedule.kind === "cron" ? occurrenceForOffset(at, schedule.timezone) : new Date(at).toISOString();
  const prefix = dream ? DREAM_DELIVERY_PREFIX : "schedule:";
  return { agentId, occurredAt: new Date(at).toISOString(), prompt: schedule.prompt, deliveryId: `${prefix}${key}:${local}`, ...(dream === true ? { dream } : {}) };
}

export function nextOccurrence(agentId: string, schedule: ActiveSchedule, anchor: number | undefined, from: number): number {
  assertTaskInstant(from);
  if (anchor !== undefined) assertTaskInstant(anchor);
  if (schedule.kind === "every") {
    const base = anchor ?? from;
    return assertTaskInstant(base > from ? base : base + (Math.floor((from - base) / schedule.interval_ms) + 1) * schedule.interval_ms);
  }
  const fields = parseCron(schedule.cron);
  if (!calendarPossible(fields)) throw new Error(`schedule ${agentId} is impossible`);
  const found = searchCron(fields, schedule.timezone, from, from + SEARCH_HORIZON_MS, 1);
  if (found !== undefined) return assertTaskInstant(found);
  throw new Error(`schedule ${agentId} has no occurrence within the deterministic search bound`);
}

export function cronIsPossible(cron: string): boolean { try { return calendarPossible(parseCron(cron)); } catch { return false; } }

/** Independent per-arming offset in `[0, jitter_seconds * 1000]`; absent/zero jitter always yields exactly 0. */
export function jitterOffsetMs(schedule: ActiveSchedule | undefined, random: () => number): number {
  const jitterSeconds = schedule?.jitter_seconds ?? 0;
  if (jitterSeconds <= 0) return 0;
  const bound = jitterSeconds * 1_000;
  return Math.min(bound, Math.max(0, Math.floor(random() * (bound + 1))));
}

function withFireTarget(entry: Entry, schedule: ActiveSchedule, random: () => number): Entry {
  const offset = jitterOffsetMs(schedule, random);
  return offset === 0 ? entry : { ...entry, fire_at_ms: assertTaskInstant(entry.next_due_ms + offset) };
}

function latestEligibleOccurrence(schedule: ActiveSchedule, due: number, at: number): number {
  if (schedule.kind === "every") return due + Math.floor((at - due) / schedule.interval_ms) * schedule.interval_ms;
  const result = searchCron(parseCron(schedule.cron), schedule.timezone, Math.max(due, at - SEARCH_HORIZON_MS), at, -1);
  if (result === undefined) throw new Error("schedule state has no eligible occurrence within the deterministic search bound");
  return result;
}

type CronFields = readonly (readonly number[])[] & Readonly<{ dayOfMonthWildcard: boolean; dayOfWeekWildcard: boolean }>;
function parseCron(cron: string): CronFields {
  const raw = cron.trim().split(/\s+/u);
  if (raw.length !== 5) throw new Error("cron is invalid");
  return Object.assign(raw.map((field, index) => parseField(field, CRON_FIELD_BOUNDS[index]!)), {
    dayOfMonthWildcard: raw[2] === "*", dayOfWeekWildcard: raw[4] === "*"
  }) as CronFields;
}
function parseField(value: string, [minimum, maximum]: readonly [number, number]): readonly number[] {
  const result = new Set<number>();
  for (const part of value.split(",")) {
    const [range, rawStep] = part.split("/"); const step = Number(rawStep ?? 1);
    const bounds = range === "*" ? [minimum, maximum] : range!.split("-").map(Number);
    const first = bounds[0]!; const last = bounds[1] ?? first;
    if (!Number.isSafeInteger(step) || step < 1 || !Number.isInteger(first) || !Number.isInteger(last) || first < minimum || last > maximum || first > last) throw new Error("cron is invalid");
    for (let current = first; current <= last; current += step) result.add(current === 7 && maximum === 7 ? 0 : current);
  }
  return [...result].sort((left, right) => left - right);
}
function calendarPossible(fields: CronFields): boolean {
  for (let year = 2000; year < 2400; year += 1) for (const month of fields[3]!) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day += 1) if (dateMatches(fields, { year, month, day, hour: 0, minute: 0, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() })) return true;
  }
  return false;
}
function searchCron(fields: CronFields, zone: string, start: number, end: number, direction: 1 | -1): number | undefined {
  let checks = 0;
  const firstDay = Math.floor((direction === 1 ? start : end) / 86_400_000) * 86_400_000;
  const lastDay = Math.floor((direction === 1 ? end : start) / 86_400_000) * 86_400_000;
  for (let day = firstDay; direction === 1 ? day <= lastDay : day >= lastDay; day += direction * 86_400_000) {
    const boundary = [parts(day, zone), parts(day + 86_340_000, zone)]; checks += 2;
    if (!boundary.some((value) => dateMatches(fields, value))) continue;
    const nextMinute = Math.floor(start / 60_000) * 60_000 + 60_000;
    const low = Math.max(direction === 1 ? nextMinute : start, day); const high = Math.min(end, day + 86_340_000);
    let candidate = direction === 1 ? Math.ceil(low / 60_000) * 60_000 : Math.floor(high / 60_000) * 60_000;
    for (; direction === 1 ? candidate <= high : candidate >= low; candidate += direction * 60_000) {
      if (++checks > MAX_SEARCH_CHECKS) throw new Error("cron search exceeded its deterministic work bound");
      if (matches(fields, parts(candidate, zone))) return candidate;
    }
  }
  return undefined;
}
function dateMatches(fields: CronFields, value: Parts): boolean {
  if (!fields[3]!.includes(value.month)) return false;
  const dom = fields[2]!.includes(value.day); const dow = fields[4]!.includes(value.weekday);
  return fields.dayOfMonthWildcard ? dow : fields.dayOfWeekWildcard ? dom : dom || dow;
}
function matches(fields: CronFields, value: Parts): boolean { return fields[0]!.includes(value.minute) && fields[1]!.includes(value.hour) && dateMatches(fields, value); }

type Parts = Readonly<{ year: number; month: number; day: number; hour: number; minute: number; weekday: number }>;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (value === undefined) { value = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }); formatters.set(zone, value); }
  return value;
}
function parts(at: number, zone: string): Parts {
  const values = formatter(zone).formatToParts(at); const get = (name: string): string => values.find((part) => part.type === name)?.value ?? "0";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")), hour: Number(get("hour")), minute: Number(get("minute")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
}
function occurrenceForOffset(at: number, zone: string): string {
  const value = parts(at, zone); const local = `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}T${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`;
  const key = `${zone}\u0000offset`; let offset = formatters.get(key);
  if (offset === undefined) { offset = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }); formatters.set(key, offset); }
  return `${local}@${offset.formatToParts(at).find((part) => part.type === "timeZoneName")?.value ?? "UTC"}`;
}
function matchesDreamInstant(schedule: ActiveSchedule, at: number): boolean {
  return schedule.kind === "every" || (at % 60_000 === 0 && matches(parseCron(schedule.cron), parts(at, schedule.timezone)));
}
function newer(left: ScheduledOccurrence | undefined, right: ScheduledOccurrence): ScheduledOccurrence { return left !== undefined && Date.parse(left.occurredAt) > Date.parse(right.occurredAt) ? left : right; }

async function restore(
  file: string,
  allowed: ReadonlyMap<string, ScheduleSlot>
): Promise<State> {
  let bytes: Buffer;
  try {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600 || entry.size > MAX_STATE_BYTES) throw new Error("schedule state is unsafe");
    bytes = await readFile(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: STATE_VERSION, schedules: {} }; throw error; }
  if (bytes.length > MAX_STATE_BYTES) throw new Error("schedule state exceeds its bound");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule state is invalid");
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join() !== "schedules,version" || root.version !== STATE_VERSION || !root.schedules || typeof root.schedules !== "object" || Array.isArray(root.schedules)) throw new Error("schedule state is invalid");
  const schedules: Record<string, Entry> = {};
  for (const [key, raw] of Object.entries(root.schedules as Record<string, unknown>)) {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("schedule state is invalid");
    const slot = allowed.get(key);
    if (slot === undefined) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule state is invalid");
    const { prefer_dream, ...entry } = raw as Record<string, unknown>;
    const keys = Object.keys(entry).sort().join();
    if (prefer_dream !== undefined && (slot.dream !== true || prefer_dream !== true)) throw new Error("schedule state is invalid");
    if (!["fire_at_ms,next_due_ms", "fire_at_ms,latest_pending,next_due_ms", "latest_pending,next_due_ms", "next_due_ms"].includes(keys)) throw new Error("schedule state is invalid");
    if (!validTaskInstant(entry.next_due_ms)) throw new Error("schedule state is invalid");
    const nextDue = entry.next_due_ms as number;
    const fireAt = entry.fire_at_ms;
    if (fireAt !== undefined) {
      const maximumFireAt = nextDue + jitterOffsetMs(slot.schedule, () => 0.999_999_999);
      if (!validTaskInstant(fireAt) || fireAt < nextDue || fireAt > maximumFireAt) throw new Error("schedule state is invalid");
    }
    const pending = entry.latest_pending === undefined ? undefined : parseOccurrence(entry.latest_pending);
    if (pending !== undefined) assertRestoredOccurrence(slot, pending, nextDue);
    schedules[key] = { next_due_ms: nextDue, ...(fireAt === undefined ? {} : { fire_at_ms: fireAt as number }), ...(pending === undefined ? {} : { latest_pending: pending }), ...(prefer_dream === undefined ? {} : { prefer_dream }) };
  }
  return { version: STATE_VERSION, schedules };
}
function assertRestoredOccurrence(
  slot: ScheduleSlot,
  pending: ScheduledOccurrence,
  nextDue: number
): void {
  const occurred = Date.parse(pending.occurredAt);
  const expected = slotOccurrence(slot, occurred);
  if (pending.agentId !== expected.agentId || pending.prompt !== expected.prompt || pending.dream !== expected.dream ||
      pending.deliveryId !== expected.deliveryId || (slot.dream === true && !matchesDreamInstant(slot.schedule, occurred)) ||
      nextDue !== nextOccurrence(slot.agentId, slot.schedule, occurred, occurred)) {
    throw new Error("schedule state is invalid");
  }
}
function parseOccurrence(value: unknown): ScheduledOccurrence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule state is invalid");
  const item = value as Record<string, unknown>;
  const { dream, ...fields } = item;
  if ((Object.hasOwn(item, "dream") && dream !== true) || Object.keys(fields).sort().join() !== "agentId,deliveryId,occurredAt,prompt"
      || Object.values(fields).some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 16_384)) throw new Error("schedule state is invalid");
  const occurredAt = fields.occurredAt as string;
  if (!validTaskInstant(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt || !isCanonicalScheduleDeliveryId(fields.deliveryId as string)) throw new Error("schedule state is invalid");
  return item as unknown as ScheduledOccurrence;
}
async function persist(file: string, value: State, directory: Awaited<ReturnType<typeof open>>, observe?: ScheduleControllerOptions["onPersistStageForTest"]): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > MAX_STATE_BYTES) throw new Error("schedule state exceeds its bound");
  const temporary = path.join(path.dirname(file), `.schedule-state-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
  try { await handle.writeFile(bytes); observe?.("write"); await handle.sync(); observe?.("file-sync"); } finally { await handle.close(); }
  try { await rename(temporary, file); observe?.("rename"); await directory.sync(); observe?.("directory-sync"); } finally { await unlink(temporary).catch(() => undefined); }
}
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function directoryFlag(): number { return (constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0; }
