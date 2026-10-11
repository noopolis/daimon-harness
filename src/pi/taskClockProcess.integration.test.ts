import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { verifyTaskClockProcess } from "./taskClockProcess.js";
import { PiHarnessAdapter } from "./piHarness.js";
import { spawnEngine } from "./cliEngineSpawn.js";
import { readChild } from "./cliChildOutput.js";
import { readTaskClock } from "../runtime/taskClock.js";
import { createProductionAgentTools } from "../runtime/productionAgentTools.js";

test("libfaketime changes actual CLI, MCP, Pi bash and descendant clocks across staggered starts", { timeout: 15000 }, async (t) => {
  if (process.platform !== "linux") { t.skip("requires caller-installed Linux libfaketime; macOS does not support LD_PRELOAD"); return; }
  let library: string | undefined;
  for (const candidate of [process.env.DAIMON_TEST_LIBFAKETIME, "/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1", "/usr/lib/aarch64-linux-gnu/faketime/libfaketime.so.1", "/usr/local/lib/faketime/libfaketime.so.1"]) {
    if (candidate && await access(candidate).then(() => true, () => false)) { library = candidate; break; }
  }
  if (!library) { t.skip("caller must install libfaketime or set DAIMON_TEST_LIBFAKETIME to its library path"); return; }
  const previous = process.env, anchor = Date.now();
  process.env = { ...previous, NOOPOLIS_RUN_ID: "live-clock", LD_PRELOAD: library, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: anchor }) };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-libfaketime-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  const historical = process.env.NOOPOLIS_TASK_CLOCK;
  for (const offsetMs of [0, 3000, -3000]) {
    const realNow = Date.now();
    process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: new Date(realNow + offsetMs).toISOString(), anchorEpochMs: realNow });
    await verifyTaskClockProcess(root);
  }
  process.env.NOOPOLIS_TASK_CLOCK = historical;
  const observed: number[] = [];
  const check = (result: { languageMs: number; dateSeconds: number }) => {
    for (const value of [result.languageMs, result.dateSeconds * 1000]) assert.ok(Math.abs(value - readTaskClock()!.now()) < 5000, `process clock ${value} must observe task time`);
    observed.push(result.languageMs);
  };
  const observation = `const {execFileSync}=require('node:child_process');console.log(JSON.stringify({languageMs:Date.now(),dateSeconds:Number(execFileSync('/bin/date',['-u','+%s'],{encoding:'utf8'}).trim())}));`;
  const command = path.join(root, "engine.cjs");
  await writeFile(command, `#!${process.execPath}\n${observation}`); await chmod(command, 0o700);
  for (const engine of ["codex", "grok", "agy"] as const) {
    const child = spawnEngine({ engine, command }, "hello", { cwd: root, runtimeHomePath: root }, undefined);
    check(JSON.parse(await readChild(child, 5000, [])));
    await delay(1100);
  }
  const agent = { id: "a", name: "A", instructions: "test", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" as const } };
  const [tool] = await createProductionAgentTools({ ...agent, mcp: [{ name: "clock", transport: "stdio", command: process.execPath, args: [path.resolve("src/runtime/fixtures/testMcpServer.mjs")], env: { DAIMON_TEST_MCP_TOOLS: "process_clock" }, tools: ["process_clock"] }] }, { current: "clock-wake" });
  check((await tool!.execute("call", {}, undefined, undefined, {} as never)).details as { languageMs: number; dateSeconds: number });
  const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), model: { auth: { method: "none" }, endpoint: { baseUrl: "http://127.0.0.1", compatibility: "openai" }, name: "stub", provider: "stub" }, sessionFactory: async (input) => {
    const bash = input.customTools!.find((item) => item.name === "bash")!;
    return { session: { subscribe: () => () => {}, dispose() {}, async prompt() {
      const result = await bash.execute("observe", { command: "./engine.cjs" }, undefined, undefined, {} as never);
      check(JSON.parse((result.content[0] as { text: string }).text));
    } } };
  } });
  const handle = await adapter.startAgent(agent);
  try { await handle.wake({ id: "one", kind: "manual", text: "observe" }); await delay(1100); await handle.wake({ id: "two", kind: "manual", text: "observe" }); }
  finally { await handle.stop(); }
  assert.ok(observed.at(-1)! - observed[0]! >= 4000, "relative offsets must not restart the clock in each process");
  assert.ok(Math.abs(Date.now() - anchor) < 15000, "Daimon's accounting clock stays real");
});
