import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeSchedule } from "./organizationRuntime.js";

const STATE_VERSION = "noopolis.daimon.schedule-state.v1" as const;
const STATE_FILE = "schedule-state.v1.json";
const MAX_STATE_BYTES = 256 * 1024;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;
const SEARCH_HORIZON_MS = 64 * 366 * 86_400_000;
const MAX_SEARCH_CHECKS = 1_000_000;
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export type ScheduledOccurrence = Readonly<{ agentId: string; deliveryId: string; occurredAt: string; prompt: string }>;
type ActiveSchedule = Exclude<OrganizationRuntimeSchedule, { kind: "disabled" }>;
type Entry = Readonly<{ next_due_ms: number; fire_at_ms?: number; latest_pending?: ScheduledOccurrence }>;
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
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? clearTimeout;
  const statePath = path.join(options.acceptanceStorePath, STATE_FILE);
  const active = options.agents.filter((agent) => agent.schedule && agent.schedule.kind !== "disabled") as Array<OrganizationRuntimeAgentConfig & { schedule: ActiveSchedule }>;
  const byKey = new Map(active.map((agent) => [identity(agent.id, agent.schedule), agent]));
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
  const nextEntry = (agent: OrganizationRuntimeAgentConfig & { schedule: ActiveSchedule }, anchor: number | undefined, observedNow: number, latest_pending?: ScheduledOccurrence): Entry => {
    const next_due_ms = nextOccurrence(agent.id, agent.schedule, anchor, observedNow);
    return withFireTarget({ next_due_ms, ...(latest_pending === undefined ? {} : { latest_pending }) }, agent.schedule, random);
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
  const drainKey = async (key: string): Promise<void> => {
    if (stopped) return;
    const pending = state.schedules[key]?.latest_pending;
    if (pending === undefined) return;
    const accepted = await options.accept(pending);
    if (accepted === false || stopped) return;
    const current = state.schedules[key];
    if (current?.latest_pending?.deliveryId !== pending.deliveryId) return;
    state = { ...state, schedules: { ...state.schedules, [key]: withoutPending(current) } };
    await save();
  };
  const onTimer = async (key: string): Promise<void> => {
    if (stopped) return;
    const agent = byKey.get(key); const entry = state.schedules[key];
    if (agent === undefined || entry === undefined) return;
    const observedNow = now();
    const fireAt = entry.fire_at_ms ?? entry.next_due_ms;
    if (fireAt > observedNow) { arm(key); return; }
    const elapsed = latestEligibleOccurrence(agent.schedule, entry.next_due_ms, observedNow);
    state = { ...state, schedules: { ...state.schedules, [key]: nextEntry(agent, elapsed, observedNow, occurrenceFor(agent.id, agent.schedule, elapsed)) } };
    await save(); arm(key); await drainKey(key);
  };

  return {
    async start(): Promise<void> {
      await enqueue(async () => {
        if (directory !== undefined) return;
        directory = await open(options.acceptanceStorePath, constants.O_RDONLY | directoryFlag() | noFollow());
        state = await restore(statePath, byKey);
        const next = { ...state.schedules };
        const observedNow = now();
        for (const [key, agent] of byKey) {
          const prior = next[key];
          if (prior === undefined) next[key] = nextEntry(agent, undefined, observedNow);
          else if ((prior.fire_at_ms ?? prior.next_due_ms) <= observedNow) {
            const elapsed = latestEligibleOccurrence(agent.schedule, prior.next_due_ms, observedNow);
            const pending = occurrenceFor(agent.id, agent.schedule, elapsed);
            next[key] = nextEntry(agent, elapsed, observedNow, newer(prior.latest_pending, pending));
          } else if (prior.fire_at_ms === undefined) {
            next[key] = withFireTarget(prior, agent.schedule, random);
          }
        }
        state = { version: STATE_VERSION, schedules: next };
        await save();
        for (const key of byKey.keys()) arm(key);
        for (const key of byKey.keys()) await drainKey(key);
      });
    },
    async drain(agentId?: string): Promise<void> { await enqueue(async () => { for (const [key, agent] of byKey) if (agentId === undefined || agent.id === agentId) await drainKey(key); }); },
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear(); await mutations; await directory?.close(); directory = undefined;
    }
  };
}

export function occurrenceFor(agentId: string, schedule: ActiveSchedule, at: number): ScheduledOccurrence {
  const local = schedule.kind === "cron" ? occurrenceForOffset(at, schedule.timezone) : new Date(at).toISOString();
  return { agentId, occurredAt: new Date(at).toISOString(), prompt: schedule.prompt, deliveryId: `schedule:${identity(agentId, schedule)}:${local}` };
}

export function isCanonicalScheduleDeliveryId(value: string): boolean {
  if (value.length > 256 || !/^schedule:[a-f0-9]{64}:/u.test(value)) return false;
  const occurrence = value.slice("schedule:".length + 64 + 1);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(occurrence)
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}@(?:GMT(?:[+-]\d{2}:\d{2})?|UTC)$/u.test(occurrence);
}

export function nextOccurrence(agentId: string, schedule: ActiveSchedule, anchor: number | undefined, from: number): number {
  if (schedule.kind === "every") {
    const base = anchor ?? from;
    return base > from ? base : base + (Math.floor((from - base) / schedule.interval_ms) + 1) * schedule.interval_ms;
  }
  const fields = parseCron(schedule.cron);
  if (!calendarPossible(fields)) throw new Error(`schedule ${agentId} is impossible`);
  const found = searchCron(fields, schedule.timezone, from, from + SEARCH_HORIZON_MS, 1);
  if (found !== undefined) return found;
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
  return offset === 0 ? entry : { ...entry, fire_at_ms: entry.next_due_ms + offset };
}

function withoutPending(entry: Entry): Entry {
  return { next_due_ms: entry.next_due_ms, ...(entry.fire_at_ms === undefined ? {} : { fire_at_ms: entry.fire_at_ms }) };
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
function identity(agentId: string, schedule: OrganizationRuntimeSchedule): string { return createHash("sha256").update(JSON.stringify({ agentId, schedule })).digest("hex"); }
function newer(left: ScheduledOccurrence | undefined, right: ScheduledOccurrence): ScheduledOccurrence { return left !== undefined && Date.parse(left.occurredAt) > Date.parse(right.occurredAt) ? left : right; }

async function restore(
  file: string,
  allowed: ReadonlyMap<string, OrganizationRuntimeAgentConfig & { schedule: ActiveSchedule }>
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
    if (!allowed.has(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("schedule state is invalid");
    const entry = raw as Record<string, unknown>; const keys = Object.keys(entry).sort().join();
    if (!["fire_at_ms,next_due_ms", "fire_at_ms,latest_pending,next_due_ms", "latest_pending,next_due_ms", "next_due_ms"].includes(keys)) throw new Error("schedule state is invalid");
    if (!validTaskInstant(entry.next_due_ms)) throw new Error("schedule state is invalid");
    const nextDue = entry.next_due_ms as number;
    const fireAt = entry.fire_at_ms;
    if (fireAt !== undefined) {
      const maximumFireAt = nextDue + jitterOffsetMs(allowed.get(key)!.schedule, () => 0.999_999_999);
      if (!validTaskInstant(fireAt) || fireAt < nextDue || fireAt > maximumFireAt) throw new Error("schedule state is invalid");
    }
    const pending = entry.latest_pending === undefined ? undefined : parseOccurrence(entry.latest_pending);
    if (pending !== undefined) assertRestoredOccurrence(key, allowed.get(key)!, pending, nextDue);
    schedules[key] = { next_due_ms: nextDue, ...(fireAt === undefined ? {} : { fire_at_ms: fireAt as number }), ...(pending === undefined ? {} : { latest_pending: pending }) };
  }
  return { version: STATE_VERSION, schedules };
}
function assertRestoredOccurrence(
  key: string,
  agent: OrganizationRuntimeAgentConfig & { schedule: ActiveSchedule },
  pending: ScheduledOccurrence,
  nextDue: number
): void {
  const occurred = Date.parse(pending.occurredAt);
  const expected = occurrenceFor(agent.id, agent.schedule, occurred);
  if (pending.agentId !== agent.id || pending.prompt !== agent.schedule.prompt ||
      pending.deliveryId !== expected.deliveryId || !pending.deliveryId.startsWith(`schedule:${key}:`) ||
      nextDue !== nextOccurrence(agent.id, agent.schedule, occurred, occurred)) {
    throw new Error("schedule state is invalid");
  }
}
function parseOccurrence(value: unknown): ScheduledOccurrence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule state is invalid");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join() !== "agentId,deliveryId,occurredAt,prompt" || Object.values(item).some((entry) => typeof entry !== "string" || Buffer.byteLength(entry, "utf8") > 16_384)) throw new Error("schedule state is invalid");
  const occurredAt = item.occurredAt as string;
  if (!validTaskInstant(Date.parse(occurredAt)) || new Date(occurredAt).toISOString() !== occurredAt || !/^schedule:[a-f0-9]{64}:/u.test(item.deliveryId as string)) throw new Error("schedule state is invalid");
  return item as unknown as ScheduledOccurrence;
}
function validTaskInstant(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return false;
  const year = new Date(value).getUTCFullYear();
  return year >= 0 && year <= 9999;
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
