import { TURN_USAGE_MAX_IDENTIFIER_CHARS } from "../../runtime/turnUsageLedger.js";
import { TURN_REQUEST_LEDGER_VERSION, recordLedgerLines, resolveTurnRequestLedgerPath } from "../../runtime/turnRequestLedger.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const bounded = (value: string): string => [...value].slice(0, TURN_USAGE_MAX_IDENTIFIER_CHARS).join("");

/**
 * One AGY model step: a `step_update` of `step_type: "agent_response"` that
 * reached `state: "DONE"` with its own `usage`.
 *
 * `toolCalls` are the names of the `tool` steps that step started, in stream
 * order: names only, `[]` for a step that called nothing, and absent for every
 * step of a turn whose stream held a frame this decoder could not account for.
 * An unknown frame might have been a tool call, so it can never read as
 * "called nothing": a fabricated `[]` is byte-identical to a measured one.
 */
export type AgyStepRequest = Readonly<{ input: number; cacheRead: number; output: number; total: number; toolCalls?: readonly string[] }>;

const stepUsage = (usage: unknown): Omit<AgyStepRequest, "toolCalls"> | undefined => {
  if (!isRecord(usage)) return undefined;
  const input = tokenCount(usage.input_tokens);
  const output = tokenCount(usage.output_tokens);
  const cacheRead = tokenCount(usage.cache_read_tokens);
  if (input === undefined || output === undefined || cacheRead === undefined) return undefined;
  const reported = tokenCount(usage.total_tokens);
  const derived = input + cacheRead + output;
  return { input, cacheRead, output, total: Math.max(derived, reported ?? 0) };
};

/**
 * Per-step requests from the frames before AGY's terminal `result`.
 *
 * A tool step belongs to the model step with the highest `step_index` below
 * its own (in the captured tool turn, step 1 starts `view_file` at step 2 and
 * step 3 starts `call_mcp_tool` at step 4). `ACTIVE` and `DONE` updates of one
 * tool step share its index and count once.
 *
 * Returns `undefined` (no rows) when a model step has no decodable usage, or
 * no model step finished; rows without usage cannot be written truthfully.
 * Every other surprise (an unknown event or step type, a tool step without a
 * name or without a model step before it) keeps the rows and drops the tool
 * evidence of all of them.
 */
export const decodeAgyStepRequests = (frames: readonly JsonRecord[]): readonly AgyStepRequest[] | undefined => {
  const responses = new Map<number, Omit<AgyStepRequest, "toolCalls">>();
  const tools = new Map<number, string>();
  let accounted = true;
  for (const frame of frames) {
    if (frame.event === "init") continue;
    const step = frame.event === "step_update" && isRecord(frame.step_update) ? frame.step_update : undefined;
    const index = step === undefined ? undefined : tokenCount(step.step_index);
    if (step === undefined || index === undefined) { accounted = false; continue; }
    if (step.step_type === "user_input") continue;
    if (step.step_type === "agent_response") {
      if (step.state !== "DONE") continue;
      const usage = stepUsage(step.usage);
      if (usage === undefined) return undefined;
      responses.set(index, usage);
    } else if (step.step_type === "tool" && typeof step.tool_name === "string" && step.tool_name.length > 0) {
      tools.set(index, bounded(step.tool_name));
    } else {
      accounted = false;
    }
  }
  if (responses.size === 0) return undefined;
  const order = [...responses.keys()].sort((left, right) => left - right);
  const calls = new Map<number, string[]>(order.map((index) => [index, []]));
  for (const [index, name] of [...tools].sort(([left], [right]) => left - right)) {
    const owner = order.filter((response) => response < index).at(-1);
    if (owner === undefined) accounted = false;
    else calls.get(owner)!.push(name);
  }
  return order.map((index) => ({ ...responses.get(index)!, ...(accounted ? { toolCalls: calls.get(index)! } : {}) }));
};

export type AgyTurnRequestEntry = Readonly<{ agent: string; wake: string; requests: readonly AgyStepRequest[]; at?: string }>;

/**
 * One `noopolis.daimon.turn-requests.v1` row per AGY model step, in the field
 * meaning the Grok rows use: `input` is the whole prompt side
 * (`input_tokens + cache_read_tokens`), `fresh_input` the uncached part. AGY has
 * no cache-write bucket, so `cache_write` is `0`, as on the usage row.
 */
export const renderAgyTurnRequestLines = (entry: AgyTurnRequestEntry): string => {
  const at = entry.at ?? new Date().toISOString();
  return entry.requests.map((request, index) => `${JSON.stringify({
    v: TURN_REQUEST_LEDGER_VERSION,
    agent: bounded(entry.agent),
    wake: bounded(entry.wake),
    engine: "agy",
    at,
    request: index,
    requests: entry.requests.length,
    input: request.input + request.cacheRead,
    cached_input: request.cacheRead,
    fresh_input: request.input,
    cache_write: 0,
    output: request.output,
    total: request.total,
    ...(request.toolCalls === undefined ? {} : { tool_calls: request.toolCalls })
  })}\n`).join("");
};

/** Advisory and never rejects; a turn without decoded steps writes nothing. */
export const recordAgyTurnRequests = async (entry: AgyTurnRequestEntry, file: string = resolveTurnRequestLedgerPath()): Promise<boolean> => {
  if (entry.requests.length === 0) return false;
  try { return await recordLedgerLines(file, renderAgyTurnRequestLines(entry)); } catch { return false; }
};
