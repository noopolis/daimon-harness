import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeNativeBrokerResult, ENGINE_BROKER_NATIVE_RESULT_BYTES, type NativeBrokerTurn, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { startGrokBrokerProxy } from "./grokBrokerProxy.js";
import { boundGrokFinalReply, GROK_FINAL_REPLY_MAX_BYTES, GrokBrokerTurnMeter, parseGrokFinalReply } from "./grokBrokerTurnMeter.js";
import { EngineBrokerTurnFailure, runGrokEngineBrokerTurn, type GrokEngineBrokerTurnDependencies } from "./grokEngineBrokerTurn.js";
import { findGrokWorkerProcess } from "./grokEngineBrokerTurnEnd.js";

const lean = ["run_terminal_command", "read_file", "list_dir", "grep", "search_tool", "use_tool"].map((name) => ({ type: "function", function: { name } }));
const leanBody = JSON.stringify({ model: "grok-4.6", reasoning_effort: "low", stream: true, messages: [], tools: lean });
const usage = { prompt_tokens: 2_696, completion_tokens: 79, total_tokens: 2_775, prompt_tokens_details: { cached_tokens: 128 } };
const sse = (chunks: readonly unknown[]): string => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
const toolCall = sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-0", type: "function", function: { name: "use_tool", arguments: "{}" } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage }]);
const finalReply = (text: string): string => sse([{ choices: [{ index: 0, delta: { content: text.slice(0, 3) } }] }, { choices: [{ index: 0, delta: { content: text.slice(3) } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }]);
const turnIdFor = (agentId: string, wakeId: string): string => createHash("sha256").update(`0\0${agentId}\0${wakeId}`).digest("hex");
const untilAborted = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => { const fail = () => reject(new Error("engine broker turn failed")); if (signal.aborted) fail(); else signal.addEventListener("abort", fail, { once: true }); });

function post(port: number, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/v1/chat/completions", method: "POST", agent: false, headers: { authorization: `Bearer ${token}`, "x-grok-client-version": "1.0.34", "content-type": "application/json" } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode ?? 0)); });
    req.on("error", reject); req.end(leanBody);
  });
}

type Worker = (send: () => Promise<number>, signal: AbortSignal) => Promise<string>;
type Extra = Readonly<{ observe?: (uid: number) => Promise<{ pid: number; startTicks: string } | undefined>; signal?: AbortSignal; mcpInFlight?: () => number; identityEmpty?: (uid: number) => Promise<boolean>; maxRequests?: number; toolProcess?: (uid: number) => Promise<boolean> }>;
type Harness = Readonly<{ turn(wakeId: string, worker: Worker, timeoutMs?: number, extra?: Extra): ReturnType<typeof runGrokEngineBrokerTurn>; rows(): Promise<Record<string, unknown>[]>; endedStreams(): number }>;

/** The real proxy, meter, registry and ledgers; the launcher is a scripted worker that answers the upstream bodies in order. */
async function withBroker(bodies: readonly string[], run: (harness: Harness) => Promise<void>, turnEnd = { finalGraceMs: 60, idleMs: 400, pollMs: 10 }): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-turn-end-"));
  let call = 0, ended = 0;
  const proxy = await startGrokBrokerProxy({ accessToken: async () => "provider-token", markRejected: async () => undefined }, async () => ({ status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(bodies[Math.min(call++, bodies.length - 1)]!) }), undefined, 0);
  const ledger = path.join(root, "usage.jsonl");
  try {
    await run({
      turn: (wakeId, worker, timeoutMs = 30_000, extra = {}) => {
        const registration: EngineBrokerServiceRegistration = { agentId: "foreman", slot: 0, workerUid: 2_200, workspace: "/workspace", profilePath: "/workers/0/.grok/sandbox.toml", eventsPath: "/workers/0/.grok/sessions/sandbox-events.jsonl", profileSha256: "a".repeat(64), usageLedgerPath: ledger, limits: { maxRequests: extra.maxRequests ?? 32, maxTokens: 300_000, timeoutMs }, model: { model: "grok-4.6", reasoningEffort: "low" } };
        const deps: GrokEngineBrokerTurnDependencies = {
          turns: new EngineBrokerTurnRegistry(path.join(root, "turns")), proxy, credentialStale: () => false,
          mcp: { register: () => "mcp-capability-0123456789abcdef", revoke: () => { ended++; }, activity: () => ({ inFlight: extra.mcpInFlight?.() ?? 0, lastActivityAt: 0 }) },
          workerIdentityEmpty: extra.identityEmpty ?? (async () => true), workerReapWaitMs: 2_000,
          prepareIsolation: async () => ({ guard: async () => undefined, configVariant: "unclocked" }),
          observeWorker: extra.observe ?? (async (uid) => uid === 2_200 ? { pid: 5_151, startTicks: "777" } : undefined),
          observeToolProcess: extra.toolProcess ?? (async () => false),
          turnEnd,
          runNative: async (input: NativeBrokerTurn, signal: AbortSignal): Promise<NativeBrokerTurnResult> => {
            const text = await worker(() => post(proxy.port, input.providerCapability), signal);
            return { text, workerPid: 4_242, workerUid: 2_200, startTicks: 99n, diagnostic: { status: "ok", stage: "output", failureClass: "none", profileApplied: false, exitCode: 0, termSignal: 0, workerPid: 4_242, workerUid: 2_200, startTicks: "99" } };
          }
        };
        return runGrokEngineBrokerTurn(deps, registration, wakeId, "prompt", "http://127.0.0.1:43124/mcp", extra.signal);
      },
      rows: async () => (await readFile(ledger, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>),
      endedStreams: () => ended
    });
  } finally { await proxy.close(); await rm(root, { recursive: true, force: true }); }
}

/** The launcher's own output-limit frame (`supervise()` past `DBL_MAX_OUTPUT`), decoded by the shipped client. */
function outputLimitFrame(turnId: string): Buffer {
  const frame = Buffer.alloc(ENGINE_BROKER_NATIVE_RESULT_BYTES);
  frame.writeUInt32LE(2, 0); frame.writeUInt32LE(3, 4); frame.writeUInt32LE(2_200, 8); frame.writeUInt32LE(0, 12);
  frame.writeInt32LE(4_242, 16); frame.writeInt32LE(0, 20); frame.writeInt32LE(9, 24);
  frame.writeBigUInt64LE(99n, 32); frame.write(turnId, 40, "utf8");
  frame.writeUInt32LE(7, 108); frame.writeUInt32LE(7, 112); frame.writeUInt32LE(0, 116); frame.writeUInt32LE(0, 120);
  return frame;
}

test("a worker that gave its final reply and never exits is ended by the broker and sealed completed with that reply", async () => {
  await withBroker([toolCall, finalReply("FILED-REVISION-3")], async ({ turn, rows, endedStreams }) => {
    const started = Date.now();
    // The production hang: the model answers, Grok logs handle_prompt.done, and the process just stays.
    const result = await turn("wake-hang", async (send, signal) => { assert.equal(await send(), 200); assert.equal(await send(), 200); return untilAborted(signal); });
    // Mutation guard: without the watchdog this waits for the 30 s wall clock.
    assert.ok(Date.now() - started < 5_000, `ended after ${Date.now() - started} ms`);
    assert.deepEqual({ ...result }, { text: "FILED-REVISION-3", workerPid: 5_151, workerUid: 2_200, workerStartTime: "777", outcome: "completed", usage: { input: 5_136, cacheRead: 256, cacheWrite: 0, output: 158, total: 5_550 }, model: "grok-4.6", requests: 2, limitReason: "none" });
    assert.equal(endedStreams(), 1, "the turn's MCP routes, tunnel included, are revoked when the broker ends it");
    // Mutation guard: a final-reply seal stamped incomplete left every real Grok turn's usage partial.
    assert.deepEqual((await rows()).map((row) => [row.outcome, row.limit_reason, row.total, row.calls, row.complete]), [["completed", "none", 5_550, 2, true]]);
  });
});

test("a final-reply seal with a request the provider gave no usage for stays incomplete", async () => {
  const unmetered = toolCall.replace(/,"usage":\{[^}]*\{[^}]*\}\}/u, "");
  assert.notEqual(unmetered, toolCall);
  await withBroker([unmetered, finalReply("FILED")], async ({ turn, rows }) => {
    const result = await turn("wake-unmetered", async (send, signal) => { await send(); await send(); return untilAborted(signal); });
    assert.equal(result.outcome, "completed");
    assert.deepEqual((await rows()).map((row) => [row.outcome, row.complete, row.estimated_requests]), [["completed", false, 1]]);
  });
});

test("a worker that exits normally after its final reply is completed from its own stdout, not the proxy's copy", async () => {
  await withBroker([finalReply("PROXY-COPY")], async ({ turn }) => {
    const session = "01a0ad21-a90f-7f71-8054-93fdb4334d6a", frameUsage = { input_tokens: 2_568, output_tokens: 79, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 };
    const stdout = [
      { type: "system", subtype: "init", session_id: session },
      { type: "assistant", message: { id: "msg_0", type: "message", role: "assistant", model: "daimon-broker-grok", content: [{ type: "text", text: "STDOUT-TEXT" }], stop_reason: "end_turn", usage: frameUsage }, parent_tool_use_id: null, session_id: session },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "STDOUT-TEXT", stop_reason: "end_turn", total_cost_usd: 0.001, usage: frameUsage, modelUsage: { "grok-4.6-build": {} }, session_id: session }
    ].map((frame) => JSON.stringify(frame)).join("\n");
    const result = await turn("wake-exit", async (send) => { assert.equal(await send(), 200); return stdout; });
    assert.equal(result.text, "STDOUT-TEXT");
    assert.equal(result.workerPid, 4_242);
  });
});

test("a text answer followed by another model request is not a final reply: the turn is not cut off", async () => {
  await withBroker([finalReply("thinking out loud"), toolCall, finalReply("DONE")], async ({ turn }) => {
    const result = await turn("wake-continue", async (send, signal) => {
      assert.equal(await send(), 200);
      // Longer than the grace would be if the first answer counted from here, but the next request clears it.
      await send(); await new Promise((resolve) => setTimeout(resolve, 150));
      if (signal.aborted) return untilAborted(signal);
      await send();
      return untilAborted(signal);
    });
    assert.equal(result.text, "DONE");
    assert.equal(result.requests, 3);
  });
});

test("finished work whose stdout crossed the launcher bound is completed with its final reply, truncated with a marker", async () => {
  const long = "x".repeat(GROK_FINAL_REPLY_MAX_BYTES + 5_000);
  await withBroker([toolCall, finalReply(long)], async ({ turn, rows }) => {
    const turnId = turnIdFor("foreman", "wake-output");
    const result = await turn("wake-output", async (send) => { await send(); await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; });
    // Mutation guard: without the output-limit branch this rejects as engine_failed/output_limit.
    assert.equal(result.outcome, "completed");
    assert.equal(result.workerPid, 4_242, "the worker is the one the launcher reported");
    assert.ok(Buffer.byteLength(result.text) <= GROK_FINAL_REPLY_MAX_BYTES);
    assert.match(result.text, /\[… \d+ bytes truncated by the Daimon broker …\]$/u);
    assert.deepEqual((await rows()).map((row) => row.outcome), ["completed"]);
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("an output-limit failure with no final reply stays failed", async () => {
  await withBroker([toolCall], async ({ turn }) => {
    const turnId = turnIdFor("foreman", "wake-output-midturn");
    await assert.rejects(turn("wake-output-midturn", async (send) => { await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "engine_failed" && error.diagnostic?.failureClass === "output_limit");
  });
});

test("a worker that goes idle without ever answering is ended by the idle watchdog as a timeout", async () => {
  await withBroker([toolCall], async ({ turn, rows }) => {
    const started = Date.now();
    await assert.rejects(turn("wake-idle", async (send, signal) => { await send(); return untilAborted(signal); }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "limit_exceeded" && error.accounting?.limitReason === "timeout");
    // Mutation guard: without the idle bound this waits for the 30 s wall clock.
    assert.ok(Date.now() - started < 5_000);
    assert.deepEqual((await rows()).map((row) => [row.outcome, row.reason]), [["failed", "wake_timeout"]]);
  });
});

test("a shell command the worker runs past the idle bound is work, not a stall: the turn goes on to its final reply", async () => {
  await withBroker([toolCall, finalReply("AFTER-LONG-COMMAND")], async ({ turn }) => {
    // Grok runs run_terminal_command as its own child with a model-chosen timeout of up to ten hours;
    // neither the proxy nor the MCP facade sees it. Here it runs for three idle bounds.
    let commandRunning = false;
    const result = await turn("wake-long-command", async (send, signal) => {
      assert.equal(await send(), 200);
      commandRunning = true; await new Promise((resolve) => setTimeout(resolve, 1_200)); commandRunning = false;
      assert.equal(await send(), 200);
      return untilAborted(signal);
    }, 30_000, { toolProcess: async (uid) => uid === 2_200 && commandRunning });
    // Mutation guard: without the tool-process signal the idle watchdog ends this turn as a timeout at 400 ms.
    assert.equal(result.outcome, "completed");
    assert.equal(result.text, "AFTER-LONG-COMMAND");
  });
});

test("once the worker's last tool process ends, the idle bound counts from when it was last seen", async () => {
  await withBroker([toolCall], async ({ turn }) => {
    const started = Date.now();
    let commandRunning = true; setTimeout(() => { commandRunning = false; }, 900);
    await assert.rejects(turn("wake-command-then-stall", async (send, signal) => { await send(); return untilAborted(signal); }, 30_000, { toolProcess: async () => commandRunning }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "timeout");
    const elapsed = Date.now() - started;
    // Not at 400 ms (the command was work), not at the 30 s wall clock (a stall after it is still a stall).
    assert.ok(elapsed >= 1_250 && elapsed < 5_000, `ended after ${elapsed} ms`);
  });
});

test("a final reply is still ended on its grace even while a stray worker child stays alive", async () => {
  await withBroker([toolCall, finalReply("FILED")], async ({ turn }) => {
    const started = Date.now();
    const result = await turn("wake-final-with-child", async (send, signal) => { await send(); await send(); return untilAborted(signal); }, 30_000, { toolProcess: async () => true });
    // Mutation guard: letting the tool process hold the final-reply grace keeps a finished worker to the wall clock.
    assert.equal(result.text, "FILED");
    assert.ok(Date.now() - started < 5_000, `ended after ${Date.now() - started} ms`);
  });
});

test("a final reply that idles into the wall clock is still completed", async () => {
  await withBroker([finalReply("LATE-BUT-DONE")], async ({ turn }) => {
    const result = await turn("wake-deadline", async (send, signal) => { await send(); return untilAborted(signal); }, 300);
    assert.equal(result.outcome, "completed");
    assert.equal(result.text, "LATE-BUT-DONE");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("cached prompt reads count at a quarter against the token ceiling; fresh input and output in full", () => {
  const meter = new GrokBrokerTurnMeter({ maxRequests: 32, maxTokens: 4_000, timeoutMs: 60_000 });
  const first = meter.admit(); assert.ok("index" in first);
  // 10,000 prompt tokens, 9,000 of them cached, 100 output: 1,000 + 100 + 2,250.
  meter.settle(first.index, { input: 1_000, cacheRead: 9_000, cacheWrite: 0, output: 100, total: 10_100 }, 10);
  assert.equal(meter.snapshot().tokens, 3_350);
  assert.equal(meter.snapshot().usage?.total, 10_100, "sealed usage keeps the raw count");
  // Mutation guard: counting cached reads in full puts 10,100 against 4,000 and refuses this.
  assert.ok("index" in meter.admit());
});

test("the final-reply parser accepts only a stopped answer without tool calls, and bounds what it keeps", () => {
  const body = (text: string) => Buffer.from(text);
  assert.equal(parseGrokFinalReply(body(finalReply("hello world")), "text/event-stream"), "hello world");
  assert.equal(parseGrokFinalReply(body(toolCall), "text/event-stream"), undefined);
  assert.equal(parseGrokFinalReply(body(sse([{ choices: [{ index: 0, delta: { content: "no finish" } }] }])), "text/event-stream"), undefined);
  // Cut off or withheld is not finished.
  assert.equal(parseGrokFinalReply(body(sse([{ choices: [{ index: 0, delta: { content: "half an ans" }, finish_reason: "length" }] }])), "text/event-stream"), undefined);
  assert.equal(parseGrokFinalReply(body(sse([{ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }])), "text/event-stream"), undefined);
  assert.equal(parseGrokFinalReply(body(JSON.stringify({ choices: [{ index: 0, message: { content: "json" }, finish_reason: "stop" }] })), "application/json"), "json");
  assert.equal(boundGrokFinalReply("short", 100), "short");
  const cut = boundGrokFinalReply("é".repeat(100), 80);
  assert.ok(Buffer.byteLength(cut) <= 80);
  assert.match(cut, /^é+\n\[… \d+ bytes truncated by the Daimon broker …\]$/u);
});

test("the worker process is the identity's newest live process whose parent it does not own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-proc-"));
  const proc = async (pid: number, uid: number, parent: number, state = "S", start = `${pid}00`) => {
    await mkdir(path.join(root, String(pid)));
    await writeFile(path.join(root, String(pid), "status"), `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    await writeFile(path.join(root, String(pid), "stat"), `${pid} (a b) ${state} ${parent} ${Array.from({ length: 17 }, () => "0").join(" ")} ${start} 0 0`);
  };
  try {
    await proc(10, 0, 1); await proc(20, 2_200, 10); await proc(21, 2_200, 20); await proc(30, 2_201, 10);
    assert.deepEqual(await findGrokWorkerProcess(2_200, root), { pid: 20, startTicks: "2000" });
    assert.equal(await findGrokWorkerProcess(2_202, root), undefined);
    // A previous turn's hung worker (started earlier) beside this turn's: the newest root is this turn's.
    await proc(40, 2_200, 10, "S", "500"); await proc(41, 2_200, 10, "Z", "9000");
    assert.deepEqual(await findGrokWorkerProcess(2_200, root), { pid: 20, startTicks: "2000" });
    await proc(50, 2_200, 10, "S", "3000");
    assert.deepEqual(await findGrokWorkerProcess(2_200, root), { pid: 50, startTicks: "3000" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a broker-ended turn is sealed only after its worker identity empties", async () => {
  await withBroker([finalReply("DONE")], async ({ turn }) => {
    let polls = 0;
    // Mutation guard: sealing straight after the abort never polls the identity.
    const result = await turn("wake-reap", async (send, signal) => { await send(); return untilAborted(signal); }, 30_000, { identityEmpty: async () => ++polls >= 3 && polls !== 4 });
    assert.equal(result.outcome, "completed");
    // Empty must hold for a stable window: the glimpse at poll 3 is undone at 4, so it waits on from 5.
    assert.ok(polls >= 8, `polled ${polls} times`);
  });
});

test("a caller cancellation after the final reply stays a cancellation", async () => {
  await withBroker([finalReply("DONE")], async ({ turn }) => {
    const caller = new AbortController();
    const turnId = turnIdFor("foreman", "wake-cancel");
    // Mutation guard: without the caller veto, the output-limit failure that ends the cancelled worker is sealed completed.
    await assert.rejects(turn("wake-cancel", async (send) => { await send(); caller.abort(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; }, 30_000, { signal: caller.signal }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.code === "cancelled");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("a request limit is never finished work, even beside a final reply and an output-limit failure", async () => {
  await withBroker([finalReply("EARLY"), toolCall], async ({ turn }) => {
    const turnId = turnIdFor("foreman", "wake-limit");
    await assert.rejects(turn("wake-limit", async (send) => { await send(); await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; }, 30_000, { maxRequests: 1 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "requests");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("a final reply that hits the deadline with an MCP call still in flight is not completed", async () => {
  await withBroker([finalReply("NOT-YET")], async ({ turn }) => {
    await assert.rejects(turn("wake-mcp", async (send, signal) => { await send(); return untilAborted(signal); }, 300, { mcpInFlight: () => 1 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "timeout");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("stdout that reports an undeclared model is rejected even when a final reply was seen", async () => {
  await withBroker([finalReply("DONE")], async ({ turn }) => {
    const session = "01a0ad21-a90f-7f71-8054-93fdb4334d6a", frameUsage = { input_tokens: 2_568, output_tokens: 79, cache_read_input_tokens: 128, cache_creation_input_tokens: 0 };
    const stdout = [
      { type: "system", subtype: "init", session_id: session },
      { type: "assistant", message: { id: "msg_0", type: "message", role: "assistant", model: "daimon-broker-grok", content: [{ type: "text", text: "DONE" }], stop_reason: "end_turn", usage: frameUsage }, parent_tool_use_id: null, session_id: session },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "DONE", stop_reason: "end_turn", total_cost_usd: 0.001, usage: frameUsage, modelUsage: { "grok-4.5-build": {} }, session_id: session }
    ].map((frame) => JSON.stringify(frame)).join("\n");
    // The worker exits after the grace would have expired, so the watchdog had already claimed the turn.
    await assert.rejects(turn("wake-model", async (send) => { await send(); await new Promise((resolve) => setTimeout(resolve, 150)); return stdout; }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.outcome === "failed");
  });
});

test("an MCP call in flight at the deadline vetoes completion even though killing the worker later closes it", async () => {
  await withBroker([finalReply("NOT-YET")], async ({ turn }) => {
    let ended = false;
    await assert.rejects(turn("wake-mcp-close", async (send, signal) => { await send(); signal.addEventListener("abort", () => { setTimeout(() => { ended = true; }, 0); }); return untilAborted(signal); }, 300, { mcpInFlight: () => ended ? 0 : 1 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.accounting?.limitReason === "timeout");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("a final reply the watchdog never polled is still completed at the deadline, its worker read at the abort", async () => {
  await withBroker([finalReply("JUST-IN-TIME")], async ({ turn }) => {
    let aborted = false;
    // The worker is only observable until the turn is aborted, as in production once the launcher reaps it.
    const result = await turn("wake-late", async (send, signal) => { await send(); signal.addEventListener("abort", () => { setTimeout(() => { aborted = true; }, 0); }); return untilAborted(signal); }, 300, { observe: async () => aborted ? undefined : { pid: 6_262, startTicks: "888" } });
    assert.equal(result.outcome, "completed");
    assert.equal(result.workerPid, 6_262);
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 60_000 });
});

test("the worker is recorded while alive, so a final reply the watchdog never claimed survives a slow /proc read at the deadline", async () => {
  await withBroker([finalReply("RECORDED-EARLY")], async ({ turn }) => {
    let aborted = false;
    // A yielding observer that only sees the worker before the abort: an abort-time read would lose it.
    const observe = async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return aborted ? undefined : { pid: 7_373, startTicks: "999" }; };
    const result = await turn("wake-early", async (send, signal) => { await send(); signal.addEventListener("abort", () => { aborted = true; }); return untilAborted(signal); }, 400, { observe });
    assert.equal(result.outcome, "completed");
    assert.equal(result.workerPid, 7_373);
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 50 });
});

test("an output-limit failure with an MCP call still in flight is not completed", async () => {
  await withBroker([finalReply("DONE")], async ({ turn }) => {
    const turnId = turnIdFor("foreman", "wake-output-mcp");
    await assert.rejects(turn("wake-output-mcp", async (send) => { await send(); throw decodeNativeBrokerResult(outputLimitFrame(turnId), turnId, []) as never; }, 30_000, { mcpInFlight: () => 1 }), (error: unknown) => error instanceof EngineBrokerTurnFailure && error.diagnostic?.failureClass === "output_limit");
  }, { finalGraceMs: 60_000, idleMs: 60_000, pollMs: 10 });
});

test("the worker is read as soon as it has made a request, before any final reply exists", async () => {
  await withBroker([toolCall, finalReply("DONE")], async ({ turn }) => {
    let answered = false; const seen: boolean[] = [];
    const observe = async () => { seen.push(answered); return { pid: 8_484, startTicks: "1000" }; };
    // Mutation guard: reading the worker only at the final reply or the abort never reads it here.
    const result = await turn("wake-read-early", async (send, signal) => { await send(); await new Promise((resolve) => setTimeout(resolve, 150)); answered = true; await send(); return untilAborted(signal); }, 30_000, { observe });
    assert.equal(result.outcome, "completed");
    assert.equal(seen[0], false, `reads: ${JSON.stringify(seen)}`);
  }, { finalGraceMs: 60, idleMs: 60_000, pollMs: 20 });
});
