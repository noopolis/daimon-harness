import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cliChildEnvironment } from "./cliEnvironment.js";
import { spawnEngine } from "./cliEngineSpawn.js";
import { readChild } from "./cliChildOutput.js";

const raw = '{"version":"noopolis.task-clock.v1","origin":"2024-02-29T12:00:00+02:00","anchorEpochMs":1800000000123}';
const expected = { FAKETIME: "-90799200.123", FAKETIME_DONT_FAKE_MONOTONIC: "1", LC_ALL: "C", LD_PRELOAD: "/caller/libfaketime.so.1" };
const observedKeys = [...Object.keys(expected), "NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "MNEME_CLOCK_ANCHOR_MS", "MNEME_CLOCK_FUTURE", "FAKETIME_SKIP_CMDS", "FAKETIME_ONLY_CMDS", "DYLD_INSERT_LIBRARIES"];

test("CLI environments have one offset owner and forward only the derived process clock", (t) => {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, ...expected, MNEME_CLOCK_ORIGIN: "stale", FAKETIME: "not-forwarded", FAKETIME_DONT_FAKE_MONOTONIC: "1", LC_ALL: "C", LD_PRELOAD: expected.LD_PRELOAD };
  t.after(() => { process.env = previous; });
  process.env.LC_ALL = "de_DE.UTF-8";
  for (const home of [undefined, "/runtime"]) for (const engine of ["codex", "grok", "agy"] as const) {
    const env = cliChildEnvironment([], home, { engine });
    for (const name of observedKeys) assert.equal(env[name], (expected as Record<string, string>)[name]);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  const legacy = cliChildEnvironment([]);
  assert.deepEqual(legacy, { PATH: process.env.PATH, LANG: process.env.LANG ?? "C", LC_ALL: process.env.LC_ALL ?? "C", TZ: process.env.TZ ?? "UTC" });
  for (const name of observedKeys.filter((name) => name !== "LC_ALL")) assert.equal(cliChildEnvironment([], "/runtime")[name], undefined);
  process.env.NOOPOLIS_TASK_CLOCK = "";
  assert.throws(() => cliChildEnvironment([]), /NOOPOLIS_TASK_CLOCK/u);
});

test("actual engine children receive only the process clock; unset children receive none", async (t) => {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, MNEME_CLOCK_ORIGIN: "stale", MNEME_CLOCK_ANCHOR_MS: "123", MNEME_CLOCK_FUTURE: "stale", FAKETIME_SKIP_CMDS: "node", FAKETIME_ONLY_CMDS: "date", DYLD_INSERT_LIBRARIES: "/other", LD_PRELOAD: expected.LD_PRELOAD };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-cli-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const command = path.join(root, "engine");
  await writeFile(command, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(observedKeys)}.filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]])))));\n`);
  await chmod(command, 0o700);
  for (const engine of ["codex", "grok", "agy"] as const) {
    const child = spawnEngine({ engine, command }, "hello", { cwd: root, runtimeHomePath: root }, "http://127.0.0.1:1234/mcp");
    assert.deepEqual(JSON.parse(await readChild(child, 5000, [])), expected);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.deepEqual(JSON.parse(await readChild(spawnEngine({ engine: "codex", command }, "hello", { cwd: root }, undefined), 5000, [])), { LC_ALL: process.env.LC_ALL ?? "C" });
});
