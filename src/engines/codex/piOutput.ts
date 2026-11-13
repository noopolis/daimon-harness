import { decodeCodexTurnUsage, type CodexTurnUsage } from "./codexHeadlessResult.js";
import { tagCliChildFailure } from "../../pi/cliChildOutput.js";
import type { EngineOutputRetention } from "../piHooks.js";

export type CodexChildOutputOptions = Readonly<{
    /** The engine whose output retention keeps only its metered protocol. */
    retainNdjson?: "codex" | "agy";
    /**
     * Per-wake token ceiling for a Codex turn (`retainNdjson: "codex"` only).
     * Codex's `--json` stream reports usage exactly once, on `turn.completed`
     * — there is no incremental total to watch mid-turn — so this is
     * enforced at the earliest and only moment the crossing is observable:
     * the instant that frame is parsed off the stream. Crossing it kills the
     * child immediately (rather than letting an over-budget turn resolve as
     * a normal success) and fails the wake with a bound-named error.
     */
    codexTokenCeiling?: number;
    /**
     * Called once per parsed `turn.completed` frame (`retainNdjson: "codex"`
     * only), with that frame's decoded usage — or `undefined` when the usage
     * block is absent or malformed, which is never substituted with zeros.
     *
     * This is the only point at which a wake that is about to be killed — by
     * the ceiling, by the wall clock, or by a non-zero exit — can still hand
     * over what Codex reported it spent. Every path downstream of here either
     * rejects or discards the stream, which is how a breached wake's usage
     * used to survive only inside an error message.
     */
    onCodexTurnCompleted?: (usage: CodexTurnUsage | undefined) => void;
    /**
     * Called with the thread id from Codex's `thread.started` frame
     * (`retainNdjson: "codex"` only), the first line of every `codex exec
     * --json` stream — verified live against codex-cli 0.153.4:
     * `{"type":"thread.started","thread_id":"01a076d3-…"}`.
     *
     * That id is the only key that ties this wake to the rollout Codex writes
     * under `$CODEX_HOME/sessions/**`, where the per-model-request accounting
     * lives. The frame stays out of the retained stream: the decoder's
     * vocabulary and the retained-output budget are unchanged by reading it.
     */
    onCodexThreadStarted?: (threadId: string) => void;
}>;

/** Retain the metered protocol while discarding unbounded tool payloads. */
export const createCodexOutputRetention = (
  options: CodexChildOutputOptions,
  stdout: Buffer[],
  CLI_ENGINE_MAX_OUTPUT_BYTES: number,
  abort: (error: Error) => void
): EngineOutputRetention => {
  let stdoutRemainder = Buffer.alloc(0);
  let droppingNdjsonLine = false;
  let ndjsonCalls = 0;
  let stdoutBytes = 0;
  return {
    retain: (value) => {
      let incoming = value;
      if (droppingNdjsonLine) {
        const newline = incoming.indexOf(0x0a);
        if (newline < 0) return;
        droppingNdjsonLine = false;
        incoming = incoming.subarray(newline + 1);
      }
      stdoutRemainder = Buffer.concat([stdoutRemainder, incoming]);
      let newline: number;
      while ((newline = stdoutRemainder.indexOf(0x0a)) >= 0) {
        const line = stdoutRemainder.subarray(0, newline).toString("utf8");
        stdoutRemainder = Buffer.from(stdoutRemainder.subarray(newline + 1));
        let frame: Record<string, unknown> | undefined;
        try { const parsed = JSON.parse(line) as unknown; if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) frame = parsed as Record<string, unknown>; } catch { /* decoder reports malformed retained protocol lines */ }
        if (frame === undefined) { stdout.push(Buffer.from(`${line}\n`)); continue; }
        if (frame.type === "thread.started" && typeof frame.thread_id === "string") {
          options.onCodexThreadStarted?.(frame.thread_id);
          continue;
        }
        const item = typeof frame.item === "object" && frame.item !== null && !Array.isArray(frame.item) ? frame.item as Record<string, unknown> : undefined;
        if (frame.type === "item.completed" && (item?.type === "command_execution" || item?.type === "mcp_tool_call")) {
          ndjsonCalls += 1;
          stdout.push(Buffer.from(`${JSON.stringify({ type: frame.type, item: { type: item.type } })}\n`));
        } else if ((frame.type === "item.completed" && item?.type === "agent_message") || frame.type === "turn.completed" || frame.type === "turn.failed") {
          if (frame.type === "turn.completed") {
            // Decode and publish first, kill second: the ceiling breach is the
            // one path guaranteed to destroy this stream, so the accounting
            // has to leave the reader before the child does.
            const usage = decodeCodexTurnUsage(frame, ndjsonCalls);
            options.onCodexTurnCompleted?.(usage);
            if (options.codexTokenCeiling !== undefined && usage !== undefined && usage.total >= options.codexTokenCeiling) {
              abort(tagCliChildFailure(new Error(`Codex wake exceeded its ${options.codexTokenCeiling}-token per-wake ceiling (turn usage ${usage.total} tokens)`), "token_ceiling"));
              return;
            }
          }
          stdout.push(Buffer.from(`${line}\n`));
        }
        stdoutBytes = stdout.reduce((total, part) => total + part.length, 0);
        if (stdoutBytes > CLI_ENGINE_MAX_OUTPUT_BYTES) { abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit")); return; }
      }
      if (stdoutRemainder.length > CLI_ENGINE_MAX_OUTPUT_BYTES) {
        const prefix = stdoutRemainder.subarray(0, Math.min(stdoutRemainder.length, 4096)).toString("utf8");
        if (/"type"\s*:\s*"item\.completed"/u.test(prefix)
          && !/"type"\s*:\s*"agent_message"/u.test(prefix)) {
          const toolType = prefix.match(/"type"\s*:\s*"(command_execution|mcp_tool_call)"/u)?.[1];
          if (toolType !== undefined) { ndjsonCalls += 1; stdout.push(Buffer.from(`${JSON.stringify({ type: "item.completed", item: { type: toolType } })}\n`)); }
          stdoutRemainder = Buffer.alloc(0);
          droppingNdjsonLine = true;
        } else abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit"));
      }
    },
    finish: () => { if (stdoutRemainder.length > 0) stdout.push(stdoutRemainder); }
  };
};
