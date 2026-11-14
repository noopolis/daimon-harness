import { parseProtocolLines, type StrayOutputSink } from "../protocolLines.js";
const PUBLISHABLE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResult = (detail: string): Error =>
  new Error(`Grok CLI returned no publishable terminal response: ${detail}`);

type TerminalAssistant = Readonly<{ sessionId: string; stopReason: string; text: string }>;

/**
 * Token accounting for one turn, as the engine itself reported it.
 *
 * These are subscription-backed CLIs, so nothing here is billed: the counts are
 * real quota consumption and `notionalUsd` is what the same turn would have cost
 * at metered API rates. Kept away from anything named `cost` so a later reader
 * cannot mistake it for a charge.
 *
 * Field provenance is the `streaming-messages-json` terminal `result` frame,
 * which production hardcodes (`grokBrokerWorkerConfig.ts`). Its `result.usage`
 * is the Messages API `message.usage` shape with three *disjoint* prompt-side
 * buckets, so the full turn cost is
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`.
 */
export type GrokTurnUsage = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  calls: number;
  notionalUsd: number;
  complete: boolean;
}>;

export type GrokHeadlessTurn = Readonly<{ text: string; usage?: GrokTurnUsage }>;

/**
 * The four disjoint token buckets grok emits on `result.usage`. All four must be
 * present and be non-negative safe integers; a renamed, stringified, negative,
 * or fractional field rejects the whole block rather than silently contributing
 * a zero, because a zero bucket is byte-indistinguishable from a real one.
 */
const USAGE_TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const nonNegativeAmount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * Extract per-turn usage from the terminal `result` frame.
 *
 * Advisory: a malformed or absent usage block yields `undefined` rather than
 * failing a turn that published correctly, and never throws.
 *
 * `complete` is a stated heuristic, not a wire-observable signal. grok's own
 * embedded documentation for this stream says any bucket it cannot account for
 * "falls back to `0`, because the Messages API schema has no marker for
 * incomplete or absent usage", and instructs consumers to "read an all-zero
 * `usage` here as 'unknown', not 'free'". That is exactly the rule below. It
 * cannot catch a *partially* zero-filled turn, which sums to a plausible total
 * and is stamped `complete: true` while under-counting — so every count this
 * decoder produces is a lower bound.
 */
const decodeTurnUsage = (result: JsonRecord): GrokTurnUsage | undefined => {
  if (!isRecord(result.usage)) return undefined;
  const usage = result.usage;
  const counts = USAGE_TOKEN_FIELDS.map((field) => tokenCount(usage[field]));
  if (counts.some((count) => count === undefined)) return undefined;
  const [input, output, cacheRead, cacheWrite] = counts as [number, number, number, number];
  const total = input + cacheRead + cacheWrite + output;
  return { input, output, cacheRead, cacheWrite, total, calls: tokenCount(result.num_turns) ?? 0, notionalUsd: nonNegativeAmount(result.total_cost_usd), complete: total > 0 };
};

const decodeTerminalAssistant = (event: JsonRecord): TerminalAssistant | undefined => {
  if (event.type !== "assistant" || event.parent_tool_use_id !== null) return undefined;
  if (typeof event.session_id !== "string" || !isRecord(event.message)) throw invalidResult("invalid assistant event");
  const message = event.message;
  if (message.role !== "assistant" || typeof message.stop_reason !== "string" || !Array.isArray(message.content)) {
    throw invalidResult("invalid assistant event");
  }
  if (!PUBLISHABLE_STOP_REASONS.has(message.stop_reason)) return { sessionId: event.session_id, stopReason: message.stop_reason, text: "" };
  let text = "";
  let textBlocks = 0;
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== "string") throw invalidResult("invalid assistant content");
    if (block.type === "thinking") continue;
    if (block.type !== "text" || typeof block.text !== "string") throw invalidResult("invalid terminal content");
    text += block.text;
    textBlocks += 1;
  }
  if (textBlocks === 0 || text.trim().length === 0) throw invalidResult("empty response");
  return { sessionId: event.session_id, stopReason: message.stop_reason, text };
};

/**
 * Decode Grok's terminal message stream without treating progress messages as a
 * reply, and extract the turn's own token accounting from the same frame.
 */
export const decodeGrokHeadlessTurn = (output: string, onStray?: StrayOutputSink): GrokHeadlessTurn => {
  const lines = parseProtocolLines("grok", output, onStray);
  if (lines.length === 0) throw invalidResult("empty stream");
  let finalAssistant: TerminalAssistant | undefined;
  let result: JsonRecord | undefined;
  for (const [index, event] of lines.entries()) {
    if (!isRecord(event) || typeof event.type !== "string") throw invalidResult("invalid event");
    if (event.type === "error") {
      const rejection = asGrokAuthenticationRejected(JSON.stringify(event));
      if (rejection !== undefined) throw rejection;
      throw invalidResult("engine error");
    }
    const assistant = decodeTerminalAssistant(event);
    if (assistant !== undefined) finalAssistant = assistant;
    if (event.type === "result") {
      if (index !== lines.length - 1) throw invalidResult("non-terminal result");
      result = event;
    }
  }
  if (result === undefined || result.subtype !== "success" || result.is_error !== false) throw invalidResult("unsuccessful result");
  if (typeof result.stop_reason !== "string" || !PUBLISHABLE_STOP_REASONS.has(result.stop_reason)) throw invalidResult("non-terminal stop");
  if ("errors" in result && (!Array.isArray(result.errors) || result.errors.length > 0)) throw invalidResult("engine error");
  if (typeof result.result !== "string" || result.result.trim().length === 0) throw invalidResult("empty response");
  if (finalAssistant === undefined || finalAssistant.stopReason !== result.stop_reason ||
      finalAssistant.sessionId !== result.session_id || finalAssistant.text !== result.result) {
    throw invalidResult("terminal result mismatch");
  }
  const usage = decodeTurnUsage(result);
  return usage === undefined ? { text: result.result.trim() } : { text: result.result.trim(), usage };
};

/** Text-only view of {@link decodeGrokHeadlessTurn}, for callers that do not meter. */
import { asGrokAuthenticationRejected } from "./broker/grokAuthenticationError.js";
