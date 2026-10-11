import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawnRealTime } from "./taskClockProcess.js";
import { readChild } from "../pi/cliChildOutput.js";
import { prepareEngineExecutable, verifyAgySubscriptionEnrollment } from "./engineReadiness.js";
import { registerCliMcpServer } from "../pi/cliMcpRegistration.js";
import { runNativeBrokerTurn } from "./engineBrokerNativeClient.js";
import { acquireGrokBrokerRealmLease } from "./grokBrokerRealmLease.js";
import { refreshGrokBrokerCredential } from "./grokBrokerRefresh.js";

async function fixture(t: TestContext) {
  const previous = process.env;
  process.env = { ...previous, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }),
    LD_PRELOAD: "/missing/libfaketime.so.1", FAKETIME: "-31536000", FAKETIME_SKIP_CMDS: "bash", DYLD_INSERT_LIBRARIES: "/missing", MNEME_CLOCK_ORIGIN: "stale" };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-real-engine-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const record = path.join(root, "record.jsonl"), command = path.join(root, "engine");
  await writeFile(command, `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),clock:Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(LD_PRELOAD$|FAKETIME|DYLD_|MNEME_CLOCK_|NOOPOLIS_TASK_CLOCK$)/.test(k)))})+'\\n');console.log('engine-ready');`);
  await chmod(command, 0o700);
  const records = async () => (await readFile(record, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { root, record, command, records };
}

test("real-time boundary strips inherited clock controls without probing on this platform", async (t) => {
  const f = await fixture(t);
  const child = spawnRealTime(f.command, [], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal((await readChild(child, 1000, [])).trim(), "engine-ready");
  assert.deepEqual((await f.records())[0].clock, {});
});

test("every engine capability probe runs unshifted without an interposition probe", async (t) => {
  const f = await fixture(t);
  for (const engine of ["codex", "grok", "agy"] as const) {
    await writeFile(path.join(f.root, engine), await readFile(f.command)); await chmod(path.join(f.root, engine), 0o700);
    process.env.PATH = f.root;
    const ready = await prepareEngineExecutable("a", engine); await ready.verify();
  }
  const records = await f.records(); assert.equal(records.length, 6);
  for (const record of records) { assert.deepEqual(record.args, ["--version"]); assert.deepEqual(record.clock, {}); }
});

test("AGY enrollment, MCP registration and Grok credential refresh stay real", async (t) => {
  const f = await fixture(t);
  await verifyAgySubscriptionEnrollment("a", f.command, f.root, "unix:path=/realm/bus");
  const registration = await registerCliMcpServer({ command: f.command, cwd: f.root, env: process.env, addArgs: ["mcp", "add"], removeArgs: ["mcp", "remove"], onChild() {}, onChildSettled() {}, secretValues: [] });
  await registration.close();
  await refreshGrokBrokerCredential(f.command, f.root);
  const records = await f.records(); assert.equal(records.length, 4);
  assert.deepEqual(records.map((row) => row.args), [["models"], ["mcp", "add"], ["mcp", "remove"], ["models"]]);
  for (const record of records) assert.deepEqual(record.clock, {});
});

test("native broker transport is unshifted even when its parent has the task contract", async (t) => {
  const f = await fixture(t);
  await assert.rejects(runNativeBrokerTurn(f.command, { slot: 0, prompt: "prompt", providerCapability: "provider.Token-1", mcpCapability: "mcp.Token-2", requestId: "request-1", turnId: "turn-1", agentId: "agent-1", wakeId: "wake-1" }));
  const records = await f.records(); assert.equal(records.length, 1);
  assert.deepEqual(records[0].args, ["--client"]); assert.deepEqual(records[0].clock, {});
});


test("broker lease helpers stay real independently of agent clock readiness", async (t) => {
  const f = await fixture(t);
  await writeFile(f.command, (await readFile(f.command, "utf8")).replace("console.log('engine-ready');", ""));
  const lease = await acquireGrokBrokerRealmLease(f.root, f.command);
  await lease.close();
  const records = await f.records(); assert.equal(records.length, 1);
  assert.deepEqual(records[0].clock, {});
});
