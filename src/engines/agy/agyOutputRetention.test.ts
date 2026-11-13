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
import { createAgyOutputRetention } from "./agyOutputRetention.js";

const fixture = fileURLToPath(new URL("./fixtures/agy-stream-json-tool-result.jsonl", import.meta.url));

test("a long AGY turn whose tool output streams far past 64 KiB still publishes its reply and usage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-long-"));
  try {
    const lines = (await readFile(fixture, "utf8")).trim().split("\n");
    // The captured tool step, its output padded to 8 KiB, streamed 40 times (320 KiB) before the real turn.
    const tool = JSON.parse(lines[4]!) as { step_update: { tool_info: { output: string } } };
    tool.step_update.tool_info.output = "x".repeat(8_192);
    const engine = path.join(root, "agy-stub.mjs");
    await writeFile(engine, [
      'if (process.argv.includes("mcp")) process.exit(0);',
      `const tool = ${JSON.stringify(`${JSON.stringify(tool)}\n`)};`,
      "for (let index = 0; index < 40; index += 1) process.stdout.write(tool);",
      ...lines.map((line) => `process.stdout.write(${JSON.stringify(`${line}\n`)});`)
    ].join("\n"));
    const metered: Array<{ usage: AgyTurnUsage | CodexTurnUsage; outcome: TurnUsageOutcome }> = [];
    const replies: string[] = [];
    const { session } = await createCliSessionFactory({
      command: process.execPath, commandArgs: [engine], engine: "agy", timeoutMs: 10_000,
      onTurnUsage: async (usage, outcome) => { metered.push({ usage, outcome }); }
    })({ cwd: root });
    session.subscribe((event) => { if (event.type === "turn_end") replies.push(JSON.stringify(event.message)); });
    await session.prompt("wake");
    assert.match(replies.join(""), /GLYPH-TANGERINE-4471/u);
    assert.deepEqual(metered.map(({ usage, outcome }) => [usage.input, usage.output, usage.complete, outcome.status]), [[44_937, 444, true, "completed"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AGY retention drops an oversized frame as a marker and refuses an oversized reply", () => {
  const stdout: Buffer[] = [];
  const failures: Error[] = [];
  const retention = createAgyOutputRetention({}, stdout, 65_536, (error) => { failures.push(error); });
  retention.retain(Buffer.from(`{"event":"step_update","step_update":{"step_index":2,"step_type":"tool","tool_info":{"output":"${"y".repeat(1_100_000)}`));
  retention.retain(Buffer.from(`"}}}\n{"event":"result","result":{"status":"SUCCESS","response":"${"z".repeat(70_000)}"}}\n`));
  assert.deepEqual(stdout.map((line) => line.toString("utf8")), ['{"event":"dropped"}\n']);
  assert.match(String(failures[0]), /CLI engine output exceeded 65536 bytes/u);
});
