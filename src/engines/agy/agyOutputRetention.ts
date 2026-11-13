import { tagCliChildFailure } from "../../pi/cliChildOutput.js";
import type { EngineOutputRetention } from "../piHooks.js";

type JsonRecord = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Retained progress frames, reduced to what the decoders read: thousands of model steps. */
export const AGY_MAX_RETAINED_PROGRESS_BYTES = 1_048_576;
/** A single unterminated line longer than this is never buffered whole. */
const AGY_MAX_LINE_BYTES = 1_048_576;

/**
 * AGY's `stream-json` carries every tool's output and every text delta, so a
 * working turn streamed past the 64 KiB reply cap within minutes ("CLI engine
 * output exceeded 65536 bytes") and was killed. Like Codex's retention, this
 * keeps only the protocol its decoders read: each `step_update` reduced to
 * `step_index`, `step_type`, `state`, `usage` and `tool_name`
 * (`agyTurnRequests.ts`), and the terminal `result` frame whole, which alone
 * stays under the reply cap. A frame of an unknown kind or a dropped oversized
 * line is kept as a bare marker so the step decoder never reads it as "no tool
 * call". Non-JSON lines are kept verbatim for the decoder to refuse.
 */
export const createAgyOutputRetention = (
  _options: unknown,
  stdout: Buffer[],
  maxOutputBytes: number,
  abort: (error: Error) => void
): EngineOutputRetention => {
  let remainder = Buffer.alloc(0);
  let dropping = false;
  let progressBytes = 0;
  const overflow = (): void => abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${maxOutputBytes} bytes`), "output_limit"));
  const keepProgress = (frame: JsonRecord): boolean => {
    const line = Buffer.from(`${JSON.stringify(frame)}\n`);
    progressBytes += line.length;
    if (progressBytes > AGY_MAX_RETAINED_PROGRESS_BYTES) { overflow(); return false; }
    stdout.push(line);
    return true;
  };
  const take = (line: Buffer): boolean => {
    let frame: unknown;
    try { frame = JSON.parse(line.toString("utf8")); } catch { stdout.push(Buffer.concat([line, Buffer.from("\n")])); return true; }
    if (!isRecord(frame) || typeof frame.event !== "string") { stdout.push(Buffer.concat([line, Buffer.from("\n")])); return true; }
    if (frame.event === "result") {
      if (line.length > maxOutputBytes) { overflow(); return false; }
      stdout.push(Buffer.concat([line, Buffer.from("\n")]));
      return true;
    }
    if (frame.event === "init") return true;
    if (frame.event !== "step_update" || !isRecord(frame.step_update)) return keepProgress({ event: frame.event });
    const { step_index, step_type, state, usage, tool_name } = frame.step_update;
    return keepProgress({ event: "step_update", step_update: { step_index, step_type, state, usage, tool_name } });
  };
  return {
    retain: (value) => {
      let rest = value;
      let newline: number;
      while ((newline = rest.indexOf(0x0a)) >= 0) {
        const line = Buffer.concat([remainder, rest.subarray(0, newline)]);
        remainder = Buffer.alloc(0);
        rest = rest.subarray(newline + 1);
        if (dropping) { dropping = false; continue; }
        if (line.length > 0 && !take(line)) return;
      }
      if (dropping) return;
      remainder = Buffer.concat([remainder, rest]);
      if (remainder.length > AGY_MAX_LINE_BYTES) {
        // A reply this large is over the cap anyway; any other frame is dropped and marked.
        if (/"event"\s*:\s*"result"/u.test(remainder.subarray(0, 4096).toString("utf8"))) { overflow(); return; }
        remainder = Buffer.alloc(0);
        dropping = true;
        keepProgress({ event: "dropped" });
      }
    },
    finish: () => { if (remainder.length > 0 && !dropping) take(remainder); }
  };
};
