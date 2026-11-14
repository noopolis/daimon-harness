import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordTurnUsage, TURN_USAGE_LEDGER_VERSION, type TurnUsageOutcome } from "../runtime/turnUsageLedger.js";
import { tagCliChildFailure } from "./cliChildOutput.js";
import { createCliSessionFactory } from "./cliSession.js";
import { failedTurnOutcome } from "./cliTurnMetering.js";
import type { AgyTurnUsage } from "../engines/agy/agyHeadlessResult.js";
import type { CodexTurnUsage } from "../engines/codex/codexHeadlessResult.js";

/**
 * A Codex wake that breaches its per-wake token ceiling recorded *nothing* in
 * the usage ledger: the only surviving trace of the 743,024 tokens it burned
 * was the number interpolated into `Codex wake exceeded its 600000-token
 * per-wake ceiling`. Every other failure mode — wall clock, killed child,
 * non-zero exit after `turn.completed` — lost the spend entirely, so an
 * organization's cost total undercounted by however much its failures cost
 * and by an amount nothing could reconstruct.
 *
 * These tests fix the boundary at the only defensible place: usage reaches the
 * ledger exactly when Codex reported it, and never otherwise.
 */

type MeteredTurn = Readonly<{ usage: AgyTurnUsage | CodexTurnUsage; outcome: TurnUsageOutcome }>;

const frame = (value: unknown): string => `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)});`;
const reply = (text: string): string => frame({ type: "item.completed", item: { type: "agent_message", text } });
const completed = (input: number, output: number, cached = 0): string =>
  frame({ type: "turn.completed", usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 } });
const stayAlive = "setInterval(() => undefined, 1000);";

/**
 * Runs one real Codex-shaped wake against a stub engine and reports both what
 * the wake did and what it metered. The failure is captured rather than
 * asserted here: every one of these cases is a *failed* wake whose accounting
 * is the thing under test.
 */
const runCodexWake = async (
  name: string,
  stub: readonly string[],
  options: Readonly<{ codexTokenCeiling?: number; timeoutMs?: number }> = {},
  onTurnUsage?: (usage: AgyTurnUsage | CodexTurnUsage, outcome: TurnUsageOutcome) => Promise<void>
): Promise<{ metered: MeteredTurn[]; failure: unknown; root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `daimon-usage-${name}-`));
  const engine = path.join(root, "codex-stub.mjs");
  await writeFile(engine, stub.join("\n"));
  const metered: MeteredTurn[] = [];
  const cleanup = async (): Promise<void> => { await rm(root, { recursive: true, force: true }); };
  try {
    const { session } = await createCliSessionFactory({
      command: process.execPath,
      commandArgs: [engine],
      engine: "codex",
      timeoutMs: 10_000,
      ...options,
      onTurnUsage: async (usage, outcome) => {
        metered.push({ usage, outcome });
        await onTurnUsage?.(usage, outcome);
      }
    })({ cwd: root });
    const failure = await session.prompt("wake").then(() => undefined, (error: unknown) => error ?? new Error("rejected with no reason"));
    return { metered, failure, root, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

test("a clean Codex completion still meters exactly one turn, marked completed", async () => {
  const run = await runCodexWake("clean", [reply("done"), completed(8_000, 120)]);
  try {
    assert.equal(run.failure, undefined);
    assert.equal(run.metered.length, 1);
    assert.deepEqual(run.metered[0].outcome, { status: "completed" });
    assert.equal(run.metered[0].usage.total, 8_120);
    assert.equal(run.metered[0].usage.input, 8_000);
    assert.equal(run.metered[0].usage.output, 120);
  } finally { await run.cleanup(); }
});

test("a Codex turn whose reported usage is mostly cached reads stays under its token ceiling", async () => {
  // The largest of eight training turns that filed their work and were then failed at the 300k default:
  // 1,030,808 tokens reported, 954,880 of them cached re-reads of the turn's own conversation.
  const run = await runCodexWake("cached", [reply("filed"), completed(1_025_067, 5_741, 954_880)], { codexTokenCeiling: 300_000 });
  try {
    assert.equal(run.failure, undefined);
    assert.deepEqual(run.metered[0].outcome, { status: "completed" });
    assert.equal(run.metered[0].usage.total, 1_030_808, "the ledger keeps the raw count");
    assert.equal(run.metered[0].usage.cacheRead, 954_880);
  } finally { await run.cleanup(); }
});

test("fresh Codex tokens still breach the ceiling beside cached reads", async () => {
  const run = await runCodexWake("fresh", [reply("over budget"), completed(900_000, 10_000, 600_000), stayAlive], { codexTokenCeiling: 300_000 });
  try {
    assert.ok(run.failure instanceof Error);
    assert.match(run.failure.message, /910000 tokens, 370000 counted/u);
    assert.deepEqual(run.metered[0].outcome, { status: "failed", reason: "token_ceiling" });
  } finally { await run.cleanup(); }
});

test("a Codex wake that breaches its token ceiling still reaches the ledger, marked failed", async () => {
  // The observed defect. The wake is still killed and still fails — only the
  // accounting changes.
  const run = await runCodexWake("ceiling", [reply("over budget"), completed(250_000, 60_000), stayAlive], { codexTokenCeiling: 300_000 });
  try {
    assert.ok(run.failure instanceof Error);
    assert.match(run.failure.message, /300000-token per-wake ceiling/u);
    assert.match(run.failure.message, /310000 tokens/u);
    assert.equal(run.metered.length, 1, "a breached wake owes the ledger exactly one row");
    assert.deepEqual(run.metered[0].outcome, { status: "failed", reason: "token_ceiling" });
    assert.equal(run.metered[0].usage.total, 310_000, "the spend that used to survive only inside the error string");
    assert.equal(run.metered[0].usage.input, 250_000);
    assert.equal(run.metered[0].usage.output, 60_000);
  } finally { await run.cleanup(); }
});

test("the failed outcome and its reason round-trip through the real ledger file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-usage-roundtrip-"));
  const file = path.join(root, "usage.jsonl");
  const run = await runCodexWake(
    "roundtrip",
    [reply("over budget"), completed(250_000, 60_000), stayAlive],
    { codexTokenCeiling: 300_000 },
    async (usage, outcome) => {
      await recordTurnUsage(file, { agent: "agent-a", wake: "wake-1", engine: "codex", usage, outcome });
    }
  );
  try {
    assert.ok(run.failure instanceof Error);
    const written = (await readFile(file, "utf8")).split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line));
    assert.equal(written.length, 1);
    assert.equal(written[0].v, TURN_USAGE_LEDGER_VERSION, "an additive field, not a new record version");
    assert.equal(written[0].outcome, "failed");
    assert.equal(written[0].reason, "token_ceiling");
    assert.equal(written[0].total, 310_000);
    assert.equal(written[0].engine, "codex");
  } finally {
    await run.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex wake killed by its wall clock still meters the usage it had already reported", async () => {
  const run = await runCodexWake("timeout", [reply("slow"), completed(40_000, 900), stayAlive], { timeoutMs: 400 });
  try {
    assert.ok(run.failure instanceof Error);
    assert.match(run.failure.message, /per-wake wall-clock bound/u);
    assert.equal(run.metered.length, 1);
    assert.deepEqual(run.metered[0].outcome, { status: "failed", reason: "wake_timeout" });
    assert.equal(run.metered[0].usage.total, 40_900);
  } finally { await run.cleanup(); }
});

test("a Codex child that exits non-zero after turn.completed still meters that turn", async () => {
  const run = await runCodexWake("exit", [reply("partial"), completed(12_000, 34), "process.exit(3);"]);
  try {
    assert.ok(run.failure instanceof Error);
    assert.match(run.failure.message, /CLI engine exited 3/u);
    assert.equal(run.metered.length, 1);
    assert.deepEqual(run.metered[0].outcome, { status: "failed", reason: "engine_exit" });
    assert.equal(run.metered[0].usage.total, 12_034);
  } finally { await run.cleanup(); }
});

test("a wake whose stream never carried turn.completed writes no row at all", async () => {
  // Never invent numbers. A zero-filled row is byte-identical to a real zero
  // and would poison every aggregate computed over the ledger, so a truncated
  // stream and a child killed before reporting record nothing whatsoever.
  const truncated = await runCodexWake("truncated", [reply("cut off"), "process.exit(9);"]);
  try {
    assert.ok(truncated.failure instanceof Error);
    assert.match(truncated.failure.message, /CLI engine exited 9/u);
    assert.deepEqual(truncated.metered, [], "no reported usage means no row, not a zero row");
  } finally { await truncated.cleanup(); }

  const killed = await runCodexWake("killed", [reply("still working"), stayAlive], { timeoutMs: 400 });
  try {
    assert.ok(killed.failure instanceof Error);
    assert.match(killed.failure.message, /per-wake wall-clock bound/u);
    assert.deepEqual(killed.metered, [], "a child killed before reporting has nothing to record");
  } finally { await killed.cleanup(); }
});

test("a Codex turn.completed with a malformed usage block is never rounded down to zero", async () => {
  const run = await runCodexWake("malformed", [
    reply("odd"),
    frame({ type: "turn.completed", usage: { input_tokens: "many", cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
    "process.exit(4);"
  ]);
  try {
    assert.ok(run.failure instanceof Error);
    assert.deepEqual(run.metered, [], "an undecodable usage block reports nothing, so nothing is written");
  } finally { await run.cleanup(); }
});

test("two turn.completed frames leave no defensible reading, so a failed wake records none", async () => {
  const run = await runCodexWake("ambiguous", [reply("twice"), completed(1_000, 10), completed(2_000, 20), "process.exit(5);"]);
  try {
    assert.ok(run.failure instanceof Error);
    assert.deepEqual(run.metered, [], "the decoder's own one-completion rule holds on the failure path too");
  } finally { await run.cleanup(); }
});

test("tool calls seen on the stream are counted into a failed wake's row", async () => {
  const run = await runCodexWake("calls", [
    frame({ type: "item.completed", item: { type: "command_execution", output: "ok" } }),
    frame({ type: "item.completed", item: { type: "mcp_tool_call", output: "ok" } }),
    reply("worked"),
    completed(70_000, 500),
    "process.exit(6);"
  ]);
  try {
    assert.ok(run.failure instanceof Error);
    assert.equal(run.metered.length, 1);
    assert.equal(run.metered[0].usage.calls, 2, "the failed row carries the same call count a published row would");
    assert.deepEqual(run.metered[0].outcome, { status: "failed", reason: "engine_exit" });
  } finally { await run.cleanup(); }
});

test("a failure that names no bound still yields a row, under the unknown reason", () => {
  // A failure raised outside the child reader carries no bound tag. The reason
  // degrades; nothing about recording the spend depends on the label.
  assert.deepEqual(failedTurnOutcome(new Error("post-spawn runtime verification failed")), { status: "failed", reason: "unknown" });
  assert.deepEqual(failedTurnOutcome("not an error"), { status: "failed", reason: "unknown" });
  assert.deepEqual(failedTurnOutcome(tagCliChildFailure(new Error("bounded"), "wake_timeout")), { status: "failed", reason: "wake_timeout" });

  // Labelling a failure must never become a second failure.
  const frozen = Object.freeze(new Error("frozen"));
  assert.doesNotThrow(() => tagCliChildFailure(frozen, "engine_exit"));
  assert.deepEqual(failedTurnOutcome(frozen), { status: "failed", reason: "unknown" });

  // A retag is a relabel, not a crash.
  const retagged = tagCliChildFailure(new Error("retag"), "output_limit");
  assert.deepEqual(failedTurnOutcome(tagCliChildFailure(retagged, "turn_rejected")), { status: "failed", reason: "turn_rejected" });

  // The tag never widens the error's own serialized surface.
  assert.deepEqual(Object.keys(tagCliChildFailure(new Error("opaque"), "token_ceiling")), []);
});
