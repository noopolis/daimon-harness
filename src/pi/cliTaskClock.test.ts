import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cliChildEnvironment } from "./cliEnvironment.js";
import { spawnEngine } from "./cliEngineSpawn.js";
import { readChild } from "./cliChildOutput.js";

const raw = '{"version":"noopolis.task-clock.v1","origin":"2024-02-29T12:00:00+02:00","anchorEpochMs":1800000000123}';
const expected = { NOOPOLIS_TASK_CLOCK: raw, MNEME_CLOCK_ORIGIN: "2024-02-29T12:00:00+02:00", MNEME_CLOCK_ANCHOR_MS: "1800000000123", FAKETIME: String(Math.round((Date.parse("2024-02-29T10:00:00Z") - 1800000000123) / 1000)), FAKETIME_DONT_FAKE_MONOTONIC: "1", LD_PRELOAD: "/caller/libfaketime.so.1" };

test("CLI environments preserve clock bytes and anchor, deriving a relative process clock and forwarding only libfaketime", (t) => {
  const previous = process.env; process.env = { ...previous, ...expected, MNEME_CLOCK_ORIGIN: "stale", FAKETIME: "not-forwarded", FAKETIME_DONT_FAKE_MONOTONIC: "1", LD_PRELOAD: expected.LD_PRELOAD };
  t.after(() => { process.env = previous; });
  for (const home of [undefined, "/runtime"]) for (const engine of ["codex", "grok", "agy"] as const) {
    const env = cliChildEnvironment([], home, { engine });
    for (const [name, value] of Object.entries(expected)) assert.equal(env[name], value);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  const legacy = cliChildEnvironment([]);
  assert.deepEqual(legacy, { PATH: process.env.PATH, LANG: process.env.LANG ?? "C", LC_ALL: process.env.LC_ALL ?? "C", TZ: process.env.TZ ?? "UTC" });
  for (const name of Object.keys(expected)) assert.equal(cliChildEnvironment([], "/runtime")[name], undefined);
  process.env.NOOPOLIS_TASK_CLOCK = "";
  assert.throws(() => cliChildEnvironment([]), /NOOPOLIS_TASK_CLOCK/u);
});

test("actual engine children receive the same origin and anchor; unset children receive none", async (t) => {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, LD_PRELOAD: expected.LD_PRELOAD };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-cli-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const command = path.join(root, "engine");
  await writeFile(command, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(expected))}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])))));\n`);
  await chmod(command, 0o700);
  for (const engine of ["codex", "grok", "agy"] as const) {
    const child = spawnEngine({ engine, command }, "hello", { cwd: root, runtimeHomePath: root }, "http://127.0.0.1:1234/mcp");
    assert.deepEqual(JSON.parse(await readChild(child, 5000, [])), expected);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.deepEqual(JSON.parse(await readChild(spawnEngine({ engine: "codex", command }, "hello", { cwd: root }, undefined), 5000, [])), {});
});
