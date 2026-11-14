import assert from "node:assert/strict";
import test from "node:test";

import { decodeAgyHeadlessTurn } from "./agy/agyHeadlessResult.js";
import { decodeCodexHeadlessTurn } from "./codex/codexHeadlessResult.js";
import { decodeGrokHeadlessTurn } from "./grok/grokHeadlessResult.js";
import { parseProtocolLines, STRAY_OUTPUT_LINE_MAX_BYTES, STRAY_OUTPUT_LINES_LOGGED } from "./protocolLines.js";

const lines = (...frames: readonly unknown[]): string[] => frames.map((frame) => JSON.stringify(frame));
// What a real AGY turn printed between its frames: a library's own error line on stdout.
const STRAY = "error: got non 200 status code: 404 (404 Not Found) from https://example.invalid/driver.zip";
const agy = lines({ event: "init", init: {} },
  { event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "Filed.", duration_seconds: 1, num_turns: 1 } });
const codex = lines({ type: "thread.started", thread_id: "t" }, { type: "item.completed", item: { id: "i", type: "agent_message", text: "ok" } },
  { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
const grok = lines({ type: "system", subtype: "init", session_id: "s" },
  { type: "assistant", parent_tool_use_id: null, session_id: "s", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
  { type: "result", subtype: "success", is_error: false, result: "done", stop_reason: "end_turn", session_id: "s" });

/** The stream with one stray line before, between and after its frames. */
const littered = (frames: readonly string[]): string => [STRAY, frames[0], STRAY, ...frames.slice(1), STRAY, ""].join("\n");

for (const [engine, frames, decode] of [
  ["agy", agy, decodeAgyHeadlessTurn], ["codex", codex, decodeCodexHeadlessTurn], ["grok", grok, decodeGrokHeadlessTurn]
] as const) {
  test(`a stray non-JSON stdout line never fails a ${engine} turn and is kept for the runtime log`, () => {
    const clean = decode(frames.join("\n"), () => assert.fail("a clean stream has no stray line"));
    const kept: string[] = [];
    // Mutation guard: each decoder threw "no publishable terminal response: invalid JSON" on the first such line.
    assert.deepEqual(decode(littered(frames), (line) => { kept.push(line); }), clean);
    assert.deepEqual(kept, Array.from({ length: 3 }, () => `daimon: engine stdout engine=${engine} line outside its JSON protocol | ${STRAY}`));
  });

  test(`a ${engine} stream with no frame at all still fails, in the decoder's own words`, () => {
    assert.throws(() => decode(`${STRAY}\n${STRAY}\n`, () => undefined), /no publishable terminal response: empty stream/u);
  });
}

test("stray lines are bounded on the log: each line by bytes, a turn by count", () => {
  const kept: string[] = [];
  const long = "x".repeat(STRAY_OUTPUT_LINE_MAX_BYTES + 500);
  const output = [long, ...Array.from({ length: STRAY_OUTPUT_LINES_LOGGED + 6 }, (_, index) => `note ${index}`), '{"ok":true}'].join("\r\n");
  assert.deepEqual(parseProtocolLines("agy", output, (line) => { kept.push(line); }), [{ ok: true }]);
  assert.equal(kept.length, STRAY_OUTPUT_LINES_LOGGED + 1);
  assert.ok(kept[0]!.endsWith("[… 500 bytes elided …]") && Buffer.byteLength(kept[0]!) < STRAY_OUTPUT_LINE_MAX_BYTES + 200);
  assert.equal(kept.at(-1), "daimon: engine stdout engine=agy 7 more lines outside its JSON protocol not shown");
});
