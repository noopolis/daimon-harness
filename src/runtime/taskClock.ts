export const TASK_CLOCK_ENV = "NOOPOLIS_TASK_CLOCK";
export const TASK_CLOCK_VERSION = "noopolis.task-clock.v1";
export const TASK_CLOCK_MIN_MS = 0;
export const TASK_CLOCK_MAX_MS = 253_402_300_799_999;

export function validTaskInstant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= TASK_CLOCK_MIN_MS && value <= TASK_CLOCK_MAX_MS;
}

export function assertTaskInstant(value: number): number {
  if (!validTaskInstant(value)) throw invalid("task instant must be within 1970-01-01T00:00:00.000Z .. 9999-12-31T23:59:59.999Z");
  return value;
}

export type TaskClock = Readonly<{
  raw: string;
  origin: string;
  anchorEpochMs: number;
  /** Convert a real epoch timestamp without resetting the shared anchor. */
  at(realEpochMs: number): number;
  now(): number;
}>;

/** Environment-only contract: no clock callbacks or compiler config in the public API. */
export function readTaskClock(environment: NodeJS.ProcessEnv = process.env): TaskClock | undefined {
  return parseTaskClock(environment[TASK_CLOCK_ENV]);
}

export function parseTaskClock(raw: string | undefined): TaskClock | undefined {
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid("must be valid JSON"); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid("must be an object");
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).sort().join() !== "anchorEpochMs,origin,version") throw invalid("requires exactly version, origin, anchorEpochMs (no unknown fields)");
  if (fields.version !== TASK_CLOCK_VERSION) throw invalid(`version must be ${TASK_CLOCK_VERSION}`);
  if (typeof fields.origin !== "string" || !validInstant(fields.origin)) throw invalid("origin must be a valid ISO-8601 instant with Z or an explicit offset");
  if (typeof fields.anchorEpochMs !== "number" || !Number.isSafeInteger(fields.anchorEpochMs)) throw invalid("anchorEpochMs must be a safe integer");
  const origin = fields.origin, anchorEpochMs = fields.anchorEpochMs, originMs = Date.parse(origin);
  assertTaskInstant(originMs);
  const at = (realEpochMs: number): number => assertTaskInstant(originMs + (realEpochMs - anchorEpochMs));
  return Object.freeze({ raw, origin, anchorEpochMs, at, now: () => at(Date.now()) });
}

/** The caller installs libfaketime; Daimon derives one process-independent offset. */
export function taskClockChildEnvironment(
  declared: NodeJS.ProcessEnv = {}, clock = readTaskClock(), environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (clock === undefined) return {};
  for (const name of Object.keys(declared)) {
    if (declared[name] !== undefined && clockVariable(name)) throw invalid(`declared child environment conflicts with ${name}`);
  }
  // Integer arithmetic keeps every millisecond even at the safe-integer anchor limits.
  const offset = BigInt(Date.parse(clock.origin)) - BigInt(clock.anchorEpochMs);
  const magnitude = offset < 0n ? -offset : offset;
  const fraction = magnitude % 1000n;
  const seconds = `${offset < 0n ? "-" : "+"}${magnitude / 1000n}${fraction === 0n ? "" : `.${String(fraction).padStart(3, "0")}`}`;
  const preload = taskClockPreload(environment.LD_PRELOAD);
  if (preload === undefined) throw invalid("process clock startup probe requires caller-provided LD_PRELOAD naming libfaketime*.so*; refusing clocked execution");
  return {
    // The child process clock owns the offset; Mneme and nested consumers use Date.now().
    // libfaketime's relative format defaults to seconds; an `s` suffix is not supported.
    FAKETIME: seconds,
    FAKETIME_DONT_FAKE_MONOTONIC: "1",
    // libfaketime parses decimal fractions using the process locale.
    LC_ALL: "C",
    LD_PRELOAD: preload
  };
}

/** Inherited environments must not reintroduce another offset owner or loader controls. */
export function taskClockProcessEnvironment(
  inherited: NodeJS.ProcessEnv, derived = taskClockChildEnvironment()
): NodeJS.ProcessEnv {
  if (Object.keys(derived).length === 0) return inherited;
  return { ...Object.fromEntries(Object.entries(inherited).filter(([name]) => !clockVariable(name))), ...derived };
}

function clockVariable(name: string): boolean {
  return /^(?:LD_PRELOAD$|DYLD_|FAKETIME|NOOPOLIS_TASK_CLOCK$|MNEME_CLOCK_)/u.test(name);
}

/** Provider/auth/control processes must never inherit the agent's process clock. */
export function realTimeProcessEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (readTaskClock() === undefined) return inherited;
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => !clockVariable(name)));
}

/** Reject mixed loader lists: unrelated libraries must never ride this exception. */
export function taskClockPreload(value: string | undefined): string | undefined {
  const libraries = value?.split(/[\s:]+/u).filter(Boolean);
  return libraries?.length && libraries.every((library) => /^libfaketime[^/]*\.so[^/]*$/u.test(library.split("/").at(-1)!)) ? value : undefined;
}

/** Use only for Daimon-owned real timestamps, never external/historical payloads. */
export function taskClockTimestamp(realTimestamp: string, clock = readTaskClock()): string {
  return clock === undefined ? realTimestamp : new Date(clock.at(Date.parse(realTimestamp))).toISOString();
}

function invalid(reason: string): Error { return new Error(`${TASK_CLOCK_ENV}: ${reason}`); }

function validInstant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/u.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}
