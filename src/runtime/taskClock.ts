export const TASK_CLOCK_ENV = "NOOPOLIS_TASK_CLOCK";
export const TASK_CLOCK_VERSION = "noopolis.task-clock.v1";

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
  const at = (realEpochMs: number): number => originMs + (realEpochMs - anchorEpochMs);
  return Object.freeze({ raw, origin, anchorEpochMs, at, now: () => at(Date.now()) });
}

/** The caller installs libfaketime; Daimon derives one process-independent offset. */
export function taskClockChildEnvironment(
  declared: NodeJS.ProcessEnv = {}, clock = readTaskClock(), environment: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  if (clock === undefined) return {};
  const seconds = Math.round((Date.parse(clock.origin) - clock.anchorEpochMs) / 1000);
  const preload = taskClockPreload(environment.LD_PRELOAD);
  const derived: Record<string, string> = {
    [TASK_CLOCK_ENV]: clock.raw,
    MNEME_CLOCK_ORIGIN: clock.origin,
    MNEME_CLOCK_ANCHOR_MS: String(clock.anchorEpochMs),
    // libfaketime's relative format defaults to seconds; an `s` suffix is not supported.
    FAKETIME: `${seconds < 0 ? "" : "+"}${seconds}`,
    FAKETIME_DONT_FAKE_MONOTONIC: "1",
    ...(preload === undefined ? {} : { LD_PRELOAD: preload })
  };
  for (const name of [...Object.keys(derived), "LD_PRELOAD"]) {
    const value = derived[name];
    if (declared[name] !== undefined && declared[name] !== value) throw invalid(`declared child environment conflicts with ${name}`);
  }
  return derived;
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
