import { decodeAgyStepRequests, type AgyStepRequest } from "./agyTurnRequests.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResult = (detail: string): Error =>
  new Error(`AGY CLI returned no publishable terminal response: ${detail}`);

/**
 * Token accounting for one AGY turn, as the engine itself reported it.
 *
 * Same shape and the same discipline as {@link import("../grok/grokHeadlessResult.js").GrokTurnUsage},
 * but AGY's envelope is *not* Grok's. Field provenance is the terminal frame of
 * `agy --print … --output-format stream-json`:
 *
 *     {"event":"result","result":{ "status":"SUCCESS", "response":"…",
 *       "num_turns":1,
 *       "usage":{"input_tokens":…, "output_tokens":…,
 *                "thinking_tokens":…, "cache_read_tokens":…, "total_tokens":…}}}
 *
 * Differences from Grok that this decoder exists to get right:
 *
 * - the prompt-side cache bucket is `cache_read_tokens`, **not**
 *   `cache_read_input_tokens`;
 * - there is no `cache_creation_input_tokens` bucket at all, so `cacheWrite` is
 *   structurally absent and recorded as `0` — absent, not measured-as-zero;
 * - there is no `total_cost_usd`, so `notionalUsd` is `0` for the same reason;
 * - `thinking_tokens` has no Grok equivalent and is a **subset** of
 *   `output_tokens`, not a disjoint bucket. The captured plain turn is
 *   `input 13,722 + output 74 = 13,796 = total_tokens` with
 *   `thinking_tokens: 73`, so adding it would double-count reasoning tokens.
 *   It is therefore read only to be ignored;
 * - AGY supplies its own `total_tokens`, which is cross-checked rather than
 *   trusted (see {@link decodeAgyTurnUsage});
 * - `status: "SUCCESS"` replaces Grok's `subtype`/`is_error` pair.
 *
 * The terminal frame's `usage` is the sum over the turn's model steps, not the
 * last step's: the captured tool turn sums three `step_update` frames
 * (14,579 + 15,079 + 15,279 input) into `input_tokens: 44,937`. Reading a
 * `step_update` would under-report every tool-using wake.
 */
export type AgyTurnUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  notionalUsd: number;
  complete: boolean;
  /** Per-model-step rows for `requests.jsonl` (`agyTurnRequests.ts`); absent when the steps were not decodable. */
  requests?: readonly AgyStepRequest[];
}>;

export type AgyHeadlessTurn = Readonly<{ text: string; usage?: AgyTurnUsage }>;

/**
 * The three token buckets AGY emits on `result.usage`. All three must be
 * present and be non-negative safe integers; a renamed, stringified, negative,
 * or fractional field rejects the whole block rather than silently contributing
 * a zero, because a zero bucket is byte-indistinguishable from a real one.
 */
const USAGE_TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens"] as const;

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Extract per-turn usage from the terminal `result` frame.
 *
 * Advisory: a malformed or absent usage block yields `undefined` rather than
 * failing a turn that published correctly, and never throws.
 *
 * `complete` follows exactly the honesty rule the Grok decoder states: AGY's
 * envelope has no marker for incomplete or absent usage either, so an all-zero
 * block reads as "unknown", not "free". It cannot catch a *partially*
 * zero-filled turn, so every count this decoder produces is a lower bound.
 *
 * AGY additionally reports its own `total_tokens`. Neither side is trusted
 * blindly: the derived sum `input + cacheRead + output` is compared against it,
 * `total` is the larger of the two so a reconciliation failure can never
 * under-report, and any disagreement clears `complete` so the record is
 * rendered as an incomplete turn rather than a verified count. A `total_tokens`
 * that is not a non-negative safe integer rejects the block outright, because
 * an unreadable total is a total that cannot be reconciled.
 */
const decodeAgyTurnUsage = (result: JsonRecord): AgyTurnUsage | undefined => {
  if (!isRecord(result.usage)) return undefined;
  const usage = result.usage;
  const counts = USAGE_TOKEN_FIELDS.map((field) => tokenCount(usage[field]));
  if (counts.some((count) => count === undefined)) return undefined;
  const [input, output, cacheRead] = counts as [number, number, number];
  const reported = usage.total_tokens === undefined ? undefined : tokenCount(usage.total_tokens);
  if (usage.total_tokens !== undefined && reported === undefined) return undefined;
  const derived = input + cacheRead + output;
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    total: reported === undefined ? derived : Math.max(derived, reported),
    calls: tokenCount(result.num_turns) ?? 0,
    notionalUsd: 0,
    complete: derived > 0 && (reported === undefined || reported === derived)
  };
};

/**
 * Decode AGY's `stream-json` NDJSON without treating a progress frame as a
 * reply, and extract the turn's own token accounting from the same frame.
 *
 * Frames before the terminal one are `{"event":"init"|"step_update", …}`.
 * Unrecognized `event` values are skipped rather than rejected: AGY owns this
 * stream and a frame kind added later must not fail a turn that published.
 * The terminal `result` frame must be the last line, exactly as with Grok.
 */
export const decodeAgyHeadlessTurn = (output: string): AgyHeadlessTurn => {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) throw invalidResult("empty stream");
  let result: JsonRecord | undefined;
  const progress: JsonRecord[] = [];
  for (const [index, line] of lines.entries()) {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { throw invalidResult("invalid JSON"); }
    if (!isRecord(frame) || typeof frame.event !== "string") throw invalidResult("invalid event");
    if (frame.event !== "result") { progress.push(frame); continue; }
    if (index !== lines.length - 1) throw invalidResult("non-terminal result");
    if (!isRecord(frame.result)) throw invalidResult("invalid result event");
    result = frame.result;
  }
  if (result === undefined) throw invalidResult("no result frame");
  if (result.status !== "SUCCESS") throw invalidResult("unsuccessful result");
  if (typeof result.response !== "string" || result.response.trim().length === 0) throw invalidResult("empty response");
  const usage = decodeAgyTurnUsage(result);
  if (usage === undefined) return { text: result.response.trim() };
  const requests = decodeAgyStepRequests(progress);
  return { text: result.response.trim(), usage: requests === undefined ? usage : { ...usage, requests } };
};

/** Text-only view of {@link decodeAgyHeadlessTurn}, for callers that do not meter. */
export const decodeAgyHeadlessResult = (output: string): string => decodeAgyHeadlessTurn(output).text;
