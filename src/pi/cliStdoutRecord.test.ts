import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ENGINE_OUTPUT_RECORD_DIRECTORY } from "../engines/descriptorContracts.js";
import { readChild, spawnEngine } from "./cliSession.js";
import { openEngineOutputRecord } from "./cliStdoutRecord.js";

const SECRET = "record-secret-0123456789";
const withHome = async (run: (home: string, directory: string) => Promise<void>): Promise<void> => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daimon-stdout-record-"));
  try { await run(home, path.join(home, ENGINE_OUTPUT_RECORD_DIRECTORY)); } finally { await rm(home, { recursive: true, force: true }); }
};

test("keeps a child's whole stdout in the runtime home, far past what the decoder retains, credentials redacted", async () => {
  await withHome(async (home, directory) => {
    const frames = 6_000;
    const engine = path.join(home, "engine.mjs");
    await writeFile(engine, `for (let i = 0; i < ${frames}; i++) console.log(JSON.stringify({ event: "step_update", index: i, pad: "p".repeat(60) })); console.log("stray ${SECRET}"); console.log(JSON.stringify({ event: "result" }));`);
    const child = spawnEngine({ command: process.execPath, commandArgs: [engine], engine: "agy", maxToolTurns: 1, timeoutMs: 20_000 }, "x", { cwd: home }, undefined);
    const record = await openEngineOutputRecord(home, "agy", "wake/1", [SECRET]);
    // The decoder keeps a bounded tail of this stream (64 KiB); the record keeps all of it.
    const retained = await readChild(child, 20_000, [SECRET], { onStdoutData: record.observe, retainStdoutTail: true });
    assert.ok(Buffer.byteLength(retained) <= 64 * 1024);
    await record.finish();
    const [name] = await readdir(directory);
    assert.match(name!, /-wake_1\.agy\.stdout\.jsonl$/u);
    const lines = (await readFile(path.join(directory, name!), "utf8")).split("\n").filter(Boolean);
    // Mutation guard: without the record these bytes exist nowhere once the child exits.
    assert.equal(lines.length, frames + 2);
    assert.equal(JSON.parse(lines[4_321]!).index, 4_321);
    assert.equal(lines.at(-2), "stray [REDACTED]");
    assert.equal((await stat(path.join(directory, name!))).mode & 0o777, 0o600);
  });
});

test("keeps only the newest wakes and marks a record that reaches its bound", async () => {
  await withHome(async (home, directory) => {
    for (let wake = 0; wake < 5; wake++) {
      const record = await openEngineOutputRecord(home, "codex", `w${wake}`, [], { kept: 3, maxBytes: 40 });
      record.observe(Buffer.from(`{"wake":${wake}}\n${"x".repeat(60)}\nnever written\n`));
      await record.finish();
      const file = path.join(directory, (await readdir(directory)).find((name) => name.includes(`-w${wake}.`))!);
      await utimes(file, new Date(1_000_000 + wake * 1_000), new Date(1_000_000 + wake * 1_000));
    }
    const names = (await readdir(directory)).sort();
    assert.deepEqual(names.map((name) => /-(w\d)\./u.exec(name)![1]), ["w2", "w3", "w4"]);
    assert.equal(await readFile(path.join(directory, names[2]!), "utf8"),
      `{"wake":4}\n${JSON.stringify({ daimon: "engine output record bound reached", bound_bytes: 40 })}\n`);
  });
});

test("never fails a turn: no runtime home or an unusable one records nothing", async () => {
  const none = await openEngineOutputRecord(undefined, "agy", "w", []);
  none.observe(Buffer.from("x\n")); await none.finish();
  const refused = await openEngineOutputRecord("/dev/null/home", "agy", "w", []);
  refused.observe(Buffer.from("x\n")); await refused.finish();
});
