import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeAgyHeadlessResult, decodeAgyHeadlessTurn } from "./agyHeadlessResult.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(path.join(fixtures, name), "utf8");

const PLAIN = "agy-stream-json-plain-result.jsonl";
const TOOL = "agy-stream-json-tool-result.jsonl";

const resultFrame = (usage: unknown, extra: Record<string, unknown> = {}) => ({
  event: "result",
  result: {
    conversation_id: "00000000-0000-4000-8000-00000000000a",
    status: "SUCCESS",
    response: "ACK",
    duration_seconds: 1.5,
    num_turns: 1,
    ...(usage === undefined ? {} : { usage }),
    ...extra
  }
});
const stream = (...events: readonly unknown[]): string => events.map((event) => JSON.stringify(event)).join("\n");
const turn = (usage: unknown, extra: Record<string, unknown> = {}) =>
  decodeAgyHeadlessTurn(stream({ event: "init", init: {} }, resultFrame(usage, extra)));

test("the live plain fixture decodes to the measured turn", () => {
  const decoded = decodeAgyHeadlessTurn(fixture(PLAIN));
  assert.equal(decoded.text, "ok");
  assert.deepEqual(decoded.usage, {
    input: 13_722, output: 74, cacheRead: 0, cacheWrite: 0,
    // 13,722 + 0 + 74. `thinking_tokens: 73` is a SUBSET of `output_tokens`
    // (the frame's own `total_tokens` is 13,796 = input + output), so adding it
    // would double-count.
    total: 13_796,
    calls: 1, notionalUsd: 0, complete: true,
    requests: [{ input: 13_722, cacheRead: 0, output: 74, total: 13_796, toolCalls: [] }]
  });
});

test("the live tool fixture reports the whole turn, not just its last step", () => {
  const decoded = decodeAgyHeadlessTurn(fixture(TOOL));
  assert.equal(decoded.text, "GLYPH-TANGERINE-4471");
  // The terminal frame's usage is the sum over the turn's model steps
  // (14,579 + 15,079 + 15,279 input), not the final step's 15,279. Reading a
  // `step_update` frame instead would under-report a tool-using wake threefold.
  const { requests, ...total } = decoded.usage!;
  assert.deepEqual(total, {
    input: 44_937, output: 444, cacheRead: 0, cacheWrite: 0,
    total: 45_381, calls: 1, notionalUsd: 0, complete: true
  });
  assert.equal(requests?.length, 3);
});

test("one tool call costs AGY roughly three times a tool-free turn", () => {
  const plain = decodeAgyHeadlessTurn(fixture(PLAIN)).usage!;
  const tool = decodeAgyHeadlessTurn(fixture(TOOL)).usage!;
  assert.ok(tool.total > plain.total * 3, `tool turn ${tool.total} vs plain ${plain.total}`);
});

test("an all-zero usage block is unknown, not free", () => {
  assert.equal(turn({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 }).usage?.complete, false);
  assert.equal(
    turn({ input_tokens: 0, output_tokens: 74, cache_read_tokens: 0 }).usage?.complete,
    true,
    "a partially zero-filled turn is byte-indistinguishable and is not detected"
  );
});

test("a usage block whose own total contradicts the buckets is reported as a lower bound", () => {
  const decoded = turn({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, total_tokens: 99 });
  assert.equal(decoded.usage?.total, 99, "never report less than either side claims");
  assert.equal(decoded.usage?.complete, false, "an unreconciled total is not a verified count");
  const understated = turn({ input_tokens: 100, output_tokens: 5, cache_read_tokens: 2, total_tokens: 3 });
  assert.equal(understated.usage?.total, 107, "a total below the buckets never wins");
  assert.equal(understated.usage?.complete, false);
  const agreeing = turn({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, total_tokens: 17 });
  assert.equal(agreeing.usage?.total, 17);
  assert.equal(agreeing.usage?.complete, true);
});

test("cache_read_input_tokens is Grok's field name and is not AGY's", () => {
  // AGY emits `cache_read_tokens`. Accepting Grok's name here would silently
  // drop every cached prompt token AGY ever reports.
  assert.equal(turn({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }).usage, undefined);
  assert.equal(turn({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 2 }).usage?.cacheRead, 2);
});

test("a renamed, negative, fractional, or stringified bucket rejects the whole block", () => {
  for (const usage of [
    { output_tokens: 5, cache_read_tokens: 0 },
    { input_tokens: -1, output_tokens: 5, cache_read_tokens: 0 },
    { input_tokens: 1.5, output_tokens: 5, cache_read_tokens: 0 },
    { input_tokens: "10", output_tokens: 5, cache_read_tokens: 0 },
    { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, total_tokens: -1 }
  ]) {
    assert.equal(turn(usage).usage, undefined, JSON.stringify(usage));
  }
  assert.equal(turn(undefined).usage, undefined, "an absent usage block never fails a turn that published");
});

test("only a terminal SUCCESS result frame publishes", () => {
  assert.throws(() => decodeAgyHeadlessResult(""), /no publishable terminal response/u);
  assert.throws(() => decodeAgyHeadlessResult("{not json}"), /no publishable terminal response/u);
  assert.throws(
    () => decodeAgyHeadlessResult(stream(resultFrame(undefined, { status: "ERROR" }))),
    /no publishable terminal response/u
  );
  assert.throws(
    () => decodeAgyHeadlessResult(stream(resultFrame(undefined, { response: "   " }))),
    /no publishable terminal response/u
  );
  assert.throws(
    () => decodeAgyHeadlessResult(stream({ event: "init", init: {} })),
    /no publishable terminal response/u
  );
  assert.throws(
    () => decodeAgyHeadlessResult(stream(resultFrame(undefined), { event: "step_update", step_update: {} })),
    /no publishable terminal response/u
  );
});

test("unknown event kinds are ignored so a new AGY frame cannot break a published turn", () => {
  assert.equal(decodeAgyHeadlessResult(stream({ event: "telemetry", whatever: 1 }, resultFrame(undefined))), "ACK");
});

test("the captured fixtures carry no capturing machine's environment", () => {
  for (const name of [PLAIN, TOOL]) {
    const text = fixture(name);
    assert.equal(/apresmoi|claude-501|scratchpad|\/Users\//u.test(text), false, name);
  }
});
