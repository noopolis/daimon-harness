import type { AgyTurnUsage } from "./agyHeadlessResult.js";
import { decodeAgyStepRequests } from "./agyTurnRequests.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A single stdout line longer than this is skipped, not buffered; its step counts as unaccounted. */
const MAX_METERED_LINE_BYTES = 1_048_576;

/** The streamed usage of one AGY turn, for a wake that never reached its terminal `result` frame. */
export type AgyTurnMeter = Readonly<{
  /** Wire this to `readChild`'s `onStdoutData`. */
  observe: (chunk: Buffer) => void;
  /**
   * The finished model steps' usage, or `undefined` when no step finished with
   * decodable usage. Always `complete: false`: the step that was in flight
   * when the turn was killed reports nothing, so the sum is a lower bound.
   */
  reported: () => AgyTurnUsage | undefined;
}>;

/**
 * AGY reports turn usage only on its terminal `result` frame, so a turn
 * killed by its wall clock used to publish no usage at all, and a timed-out
 * turn with real model output read as a hang. Each finished `agent_response`
 * step carries its own `usage` (`agyTurnRequests.ts`); this meter keeps those
 * step frames as they stream, reduced to the fields the step decoder reads.
 */
export const createAgyTurnMeter = (): AgyTurnMeter => {
  const frames: JsonRecord[] = [];
  let pending = Buffer.alloc(0);
  let skipping = false;
  const take = (line: string): void => {
    let frame: unknown;
    try { frame = JSON.parse(line); } catch { frames.push({ event: "unmetered" }); return; }
    if (!isRecord(frame) || frame.event !== "step_update" || !isRecord(frame.step_update)) return;
    const { step_index, step_type, state, usage, tool_name } = frame.step_update;
    frames.push({ event: "step_update", step_update: { step_index, step_type, state, usage, tool_name } });
  };
  return {
    observe: (chunk) => {
      let rest = chunk;
      let newline: number;
      while ((newline = rest.indexOf(0x0a)) >= 0) {
        if (skipping) skipping = false;
        else take(Buffer.concat([pending, rest.subarray(0, newline)]).toString("utf8"));
        pending = Buffer.alloc(0);
        rest = rest.subarray(newline + 1);
      }
      if (skipping) return;
      pending = Buffer.concat([pending, rest]);
      if (pending.length > MAX_METERED_LINE_BYTES) { pending = Buffer.alloc(0); skipping = true; frames.push({ event: "unmetered" }); }
    },
    reported: () => {
      const requests = decodeAgyStepRequests(frames);
      if (requests === undefined) return undefined;
      const sum = (field: "input" | "output" | "cacheRead" | "total") => requests.reduce((total, request) => total + request[field], 0);
      return { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: 0, total: sum("total"),
        calls: requests.length, notionalUsd: 0, complete: false, requests };
    }
  };
};
