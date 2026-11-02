import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decodeAgyHeadlessTurn } from "./agyHeadlessResult.js";
import { decodeAgyStepRequests, recordAgyTurnRequests, renderAgyTurnRequestLines } from "./agyTurnRequests.js";
import { agyRuntimeHooks } from "./runtimeHooks.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(path.join(fixtures, name), "utf8");
const frames = (name: string) => fixture(name).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  .filter((frame) => frame.event !== "result");

const response = (index: number) => ({ event: "step_update", step_update: { step_index: index, state: "DONE", step_type: "agent_response",
  usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3, total_tokens: 15 } } });
const tool = (index: number, name: unknown = "view_file") => ({ event: "step_update", step_update: { step_index: index, state: "ACTIVE", step_type: "tool", tool_name: name } });

test("the live tool turn records each model step's own tool calls", () => {
  const requests = decodeAgyHeadlessTurn(fixture("agy-stream-json-tool-result.jsonl")).usage?.requests;
  assert.deepEqual(requests?.map((request) => request.toolCalls), [["view_file"], ["call_mcp_tool"], []]);
  assert.deepEqual(requests?.map((request) => request.input), [14_579, 15_079, 15_279]);
});

test("the live plain turn proves one model step that called nothing", () => {
  assert.deepEqual(decodeAgyHeadlessTurn(fixture("agy-stream-json-plain-result.jsonl")).usage?.requests?.map((request) => request.toolCalls), [[]]);
});

test("a frame the decoder cannot account for is no evidence, never no tools", () => {
  for (const extra of [
    { event: "telemetry" },
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "planner_response" } },
    { event: "step_update", step_update: { state: "DONE", step_type: "tool", tool_name: "run_command" } },
    tool(2, 7)
  ]) {
    const requests = decodeAgyStepRequests([response(1), extra, response(3)]);
    assert.equal(requests?.length, 2, JSON.stringify(extra));
    assert.ok(requests?.every((request) => request.toolCalls === undefined), JSON.stringify(extra));
  }
  assert.ok(decodeAgyStepRequests([tool(0), response(1)])?.every((request) => request.toolCalls === undefined), "a tool before any model step has no owner");
});

test("a model step without decodable usage writes no rows, and repeated tool updates count once", () => {
  assert.equal(decodeAgyStepRequests([{ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response" } }]), undefined);
  assert.equal(decodeAgyStepRequests(frames("agy-stream-json-plain-result.jsonl").slice(0, 2)), undefined);
  assert.deepEqual(decodeAgyStepRequests([response(1), tool(2), tool(2), response(3)])?.map((request) => request.toolCalls), [["view_file"], []]);
});

test("rows use the turn-requests contract Spawnfile reads tool calls from", () => {
  const requests = decodeAgyStepRequests(frames("agy-stream-json-tool-result.jsonl"))!;
  const rows = renderAgyTurnRequestLines({ agent: "judge", wake: "judge-1", requests, at: "2026-11-03T00:00:00.000Z" })
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(rows[0], { v: "noopolis.daimon.turn-requests.v1", agent: "judge", wake: "judge-1", engine: "agy", at: "2026-11-03T00:00:00.000Z",
    request: 0, requests: 3, input: 14_579, cached_input: 0, fresh_input: 14_579, cache_write: 0, output: 256, total: 14_835, tool_calls: ["view_file"] });
  assert.deepEqual(rows.map((row) => row.tool_calls), [["view_file"], ["call_mcp_tool"], []]);
  const unproven = renderAgyTurnRequestLines({ agent: "judge", wake: "judge-1", requests: decodeAgyStepRequests([response(1), { event: "telemetry" }])! });
  assert.equal("tool_calls" in JSON.parse(unproven), false);
});

test("an AGY turn's usage sink appends its step rows beside the usage ledger", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agy-requests-"));
  const previous = { usage: process.env.DAIMON_TURN_USAGE_LEDGER_PATH, requests: process.env.DAIMON_TURN_REQUESTS_LEDGER_PATH };
  process.env.DAIMON_TURN_USAGE_LEDGER_PATH = path.join(directory, "usage.jsonl");
  process.env.DAIMON_TURN_REQUESTS_LEDGER_PATH = path.join(directory, "requests.jsonl");
  try {
    const options = agyRuntimeHooks.runtimeSessionOptions({ agent: { id: "judge" }, wakeEnvironmentContext: { current: "judge-1" } } as never) as { onTurnUsage: (usage: unknown, outcome: unknown) => Promise<void> };
    await options.onTurnUsage(decodeAgyHeadlessTurn(fixture("agy-stream-json-tool-result.jsonl")).usage, { status: "completed" });
    const rows = (await readFile(path.join(directory, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { wake: string; tool_calls: string[] });
    assert.deepEqual(rows.map((row) => [row.wake, row.tool_calls]), [["judge-1", ["view_file"]], ["judge-1", ["call_mcp_tool"]], ["judge-1", []]]);
    assert.equal(await recordAgyTurnRequests({ agent: "judge", wake: "w", requests: [] }, path.join(directory, "requests.jsonl")), false);
  } finally {
    for (const [name, value] of [["DAIMON_TURN_USAGE_LEDGER_PATH", previous.usage], ["DAIMON_TURN_REQUESTS_LEDGER_PATH", previous.requests]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
