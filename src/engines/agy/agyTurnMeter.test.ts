import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCliSessionFactory } from "../../pi/cliSession.js";
import type { TurnUsageOutcome } from "../../runtime/turnUsageLedger.js";
import type { AgyTurnUsage } from "./agyHeadlessResult.js";
import type { CodexTurnUsage } from "../codex/codexHeadlessResult.js";
import { createAgyTurnMeter } from "./agyTurnMeter.js";

const fixture = fileURLToPath(new URL("./fixtures/agy-stream-json-tool-result.jsonl", import.meta.url));
const lines = async () => (await readFile(fixture, "utf8")).trim().split("\n");

test("the AGY meter sums only finished model steps, split across chunk boundaries", async () => {
  const stream = (await lines()).slice(0, -1).join("\n") + "\n";
  const meter = createAgyTurnMeter();
  const bytes = Buffer.from(stream);
  for (let offset = 0; offset < bytes.length; offset += 97) meter.observe(bytes.subarray(offset, offset + 97));
  const usage = meter.reported()!;
  assert.deepEqual([usage.input, usage.output, usage.cacheRead, usage.total, usage.calls, usage.complete], [44_937, 444, 0, 45_381, 3, false]);
  assert.deepEqual(usage.requests?.map((request) => request.toolCalls), [["view_file"], ["call_mcp_tool"], []]);
  assert.equal(createAgyTurnMeter().reported(), undefined);
});

test("an AGY turn killed by its wall clock after model output still meters the finished steps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-killed-"));
  try {
    const steps = (await lines()).slice(0, 6);
    const engine = path.join(root, "agy-stub.mjs");
    // `agy mcp add/remove` exits at once; the turn streams two finished steps and then hangs.
    await writeFile(engine, [
      'if (process.argv.includes("mcp")) process.exit(0);',
      ...steps.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`),
      "setInterval(() => undefined, 1000);"
    ].join("\n"));
    const metered: Array<{ usage: AgyTurnUsage | CodexTurnUsage; outcome: TurnUsageOutcome }> = [];
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "agy", timeoutMs: 1_500,
      onTurnUsage: async (usage, outcome) => { metered.push({ usage, outcome }); }
    })({ cwd: root });
    const failure = await session.prompt("wake").then(() => undefined, (error: unknown) => error);
    assert.match(String(failure), /timed out/u);
    assert.equal(metered.length, 1);
    assert.deepEqual(metered[0]!.outcome, { status: "failed", reason: "wake_timeout" });
    assert.deepEqual([metered[0]!.usage.input, metered[0]!.usage.output, metered[0]!.usage.complete], [29_658, 368, false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
