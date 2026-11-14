import { parseProtocolLines, type StrayOutputSink } from "../protocolLines.js";
type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResult = (detail: string): Error =>
  new Error(`Codex CLI returned no publishable terminal response: ${detail}`);

/**
 * Token accounting for one Codex turn, from the terminal frame emitted by
 * `codex exec --json`:
 *
 *     {"type":"turn.completed","usage":{"input_tokens":…,
 *       "cached_input_tokens":…,"cache_write_input_tokens":…,
 *       "output_tokens":…,"reasoning_output_tokens":…}}
 *
 * Codex's reconciled session total proves `cached_input_tokens` is a subset of
 * `input_tokens`: total is `input + output`, unlike AGY's disjoint cache-read
 * bucket. Adding cacheRead would over-count every cached turn. Likewise,
 * `reasoning_output_tokens` is a subset of `output_tokens`; it is read only to
 * validate that relationship, never added. Codex reports cache writes, but no
 * cost, so `cacheWrite` is measured while `notionalUsd: 0` means absent, not
 * free. `calls` counts completed command/MCP tools; Codex exposes no AGY-like
 * model-step count, so this is explicitly a tool-call count.
 */
export type CodexTurnUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  notionalUsd: number;
  complete: boolean;
}>;

export type CodexHeadlessTurn = Readonly<{ text: string; usage?: CodexTurnUsage }>;

/**
 * Every field Codex actually emits on `turn.completed.usage`.
 *
 * `cache_write_input_tokens` is NOT in this list: Codex 0.142.3 and 0.151.0
 * both emit exactly `{input_tokens, cached_input_tokens, output_tokens,
 * reasoning_output_tokens}`, verified against a live turn inside the runtime
 * image and against `token_count` in a session rollout. Requiring the cache
 * write field made `decodeCodexTurnUsage` return `undefined` for *every* real
 * turn, so the codex half of the usage ledger recorded nothing at all while
 * every test passed against a fixture that invented the field.
 */
const USAGE_TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens"
] as const;

/** Absent means zero; present-but-malformed still degrades the whole block. */
const CACHE_WRITE_FIELD = "cache_write_input_tokens" as const;

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Advisory usage decoding: an absent or malformed block is `undefined`, never
 * a failed published turn and never a zero-filled record. Every field must be
 * a non-negative safe integer because a substituted zero is byte-identical to
 * a real zero. `complete` requires a non-zero derived total and valid subset
 * relationships. As with AGY, every emitted count remains a lower bound.
 */
export const decodeCodexTurnUsage = (frame: JsonRecord, calls: number): CodexTurnUsage | undefined => {
  if (!isRecord(frame.usage)) return undefined;
  const usage = frame.usage;
  const counts = USAGE_TOKEN_FIELDS.map((field) => tokenCount(usage[field]));
  if (counts.some((count) => count === undefined)) return undefined;
  const cacheWrite = usage[CACHE_WRITE_FIELD] === undefined ? 0 : tokenCount(usage[CACHE_WRITE_FIELD]);
  if (cacheWrite === undefined) return undefined;
  const [input, cacheRead, output, reasoningOutput] = counts as [number, number, number, number];
  const total = input + output;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    calls,
    notionalUsd: 0,
    complete: total > 0 && cacheRead <= input && reasoningOutput <= output
  };
};

/**
 * Decode Codex's NDJSON stream without mistaking tool/progress items for the
 * reply. Unknown envelopes and item types are skipped because Codex owns the
 * vocabulary and a future frame must not fail a turn that published.
 * A Codex turn that spent subscription money and produced a reply must reach
 * the organization: uncertainty about accounting degrades to `usage:
 * undefined` and never discards publishable text. Unlike AGY's stricter
 * envelope, Codex may omit, repeat, or follow `turn.completed` with another
 * frame, so only exactly one completion frame supplies trustworthy usage.
 *
 * Success is decided from the terminal frame, not from whether a reply was
 * published: `engineDispatcher.ts`'s runtime envelope tells every agent its
 * terminal response is a private note to the runtime, not an outward
 * message, and that it may "leave it empty". A `turn.completed` with no
 * `agent_message` is therefore a sanctioned silent success — `text: ""`,
 * never a thrown failure — and its usage still reaches the ledger exactly as
 * a spoken turn's would; do not reinstate throwing on empty text, it would
 * both misreport a clean turn as failed and drop its usage from the ledger
 * silently. Only `turn.failed` with no reply already published, or a stream
 * with neither terminal frame at all (a truncated or killed child), reject
 * the turn; the latter gets its own detail string so a genuinely truncated
 * stream is never confused with a legitimately silent one.
 */
export const decodeCodexHeadlessTurn = (output: string, onStray?: StrayOutputSink): CodexHeadlessTurn => {
  const lines = parseProtocolLines("codex", output, onStray);
  if (lines.length === 0) throw invalidResult("empty stream");
  let text: string | undefined;
  const completed: JsonRecord[] = [];
  let failed = false;
  let calls = 0;
  for (const frame of lines) {
    if (!isRecord(frame) || typeof frame.type !== "string") throw invalidResult("invalid event");
    if (frame.type === "turn.failed") {
      failed = true;
      continue;
    }
    if (frame.type === "turn.completed") {
      completed.push(frame);
      continue;
    }
    if (frame.type !== "item.completed" || !isRecord(frame.item) || typeof frame.item.type !== "string") continue;
    if (frame.item.type === "command_execution" || frame.item.type === "mcp_tool_call") calls += 1;
    if (frame.item.type === "agent_message" && typeof frame.item.text === "string" && frame.item.text.trim().length > 0) {
      text = frame.item.text;
    }
  }
  if (typeof text !== "string") {
    if (failed) throw invalidResult("failed turn");
    // No reply, but a completion frame arrived: a sanctioned silent success.
    if (completed.length === 0) throw invalidResult("no terminal frame");
    text = "";
  }
  const usage = !failed && completed.length === 1 ? decodeCodexTurnUsage(completed[0], calls) : undefined;
  return usage === undefined ? { text: text.trim() } : { text: text.trim(), usage };
};

/** Text-only view of {@link decodeCodexHeadlessTurn}, for callers that do not meter. */
export const decodeCodexHeadlessResult = (output: string): string => decodeCodexHeadlessTurn(output).text;
