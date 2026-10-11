import { readyTaskClockEnvironment, resetTaskClockProcessForTest } from "./taskClockProcess.js";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createProductionAgentTools } from "./productionAgentTools.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { cliChildEnvironment } from "../pi/cliEnvironment.js";
import { readTaskClock } from "./taskClock.js";

const raw = '{"version":"noopolis.task-clock.v1","origin":"2024-02-29T12:00:00+02:00","anchorEpochMs":1800000000123}';
const expected = { FAKETIME: "-90799200.123", FAKETIME_DONT_FAKE_MONOTONIC: "1", LC_ALL: "C", LD_PRELOAD: "/caller/libfaketime.so.1" };
const observedKeys = [...Object.keys(expected), "NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "MNEME_CLOCK_ANCHOR_MS", "MNEME_CLOCK_FUTURE", "FAKETIME_SKIP_CMDS", "FAKETIME_ONLY_CMDS", "DYLD_INSERT_LIBRARIES"];
async function fixture(t: TestContext) {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw, MNEME_CLOCK_ORIGIN: "stale", MNEME_CLOCK_ANCHOR_MS: "123", MNEME_CLOCK_FUTURE: "stale", FAKETIME_SKIP_CMDS: "node", FAKETIME_ONLY_CMDS: "date", DYLD_INSERT_LIBRARIES: "/other", LD_PRELOAD: expected.LD_PRELOAD };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-clock-tools-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  resetTaskClockProcessForTest();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => { Object.defineProperty(process, "platform", platform); resetTaskClockProcessForTest(); });
  // Environment propagation only; the Linux integration test covers real interposition.
  readyTaskClockEnvironment({}, undefined, (_command, _args, env) => String(Math.floor((Date.now() + Number(env.FAKETIME) * 1000) / 1000)));
  const agent: OrganizationRuntimeAgentConfig = { id: "a", name: "A", instructions: "test", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" } };
  return { root, agent };
}
test("MCP discovery and call children receive only the process clock with no second offset owner", async (t) => {
  const { agent } = await fixture(t);
  process.env.FAKETIME = "do-not-forward"; process.env.FAKETIME_DONT_FAKE_MONOTONIC = "1"; process.env.LD_PRELOAD = expected.LD_PRELOAD;
  const server = { name: "clock", transport: "stdio" as const, command: process.execPath, args: [path.resolve("src/runtime/fixtures/testMcpServer.mjs")], env: { DAIMON_TEST_MCP_TOOLS: "task_clock" }, tools: ["task_clock"] };
  // No declared clock variables: removing propagation must break this assertion.
  const declared = { DAIMON_TEST_MCP_TOOLS: "task_clock" };
  for (const env of [declared]) {
    const [tool] = await createProductionAgentTools({ ...agent, mcp: [{ ...server, env }] }, { current: `wake-${Object.keys(env).length}` });
    const result = await tool!.execute("call", {}, undefined, undefined, {} as never);
    assert.deepEqual(result.details, expected);
    const cli = cliChildEnvironment([], agent.runtimeHomePath);
    for (const name of Object.keys(expected)) assert.equal((result.details as Record<string, string>)[name], cli[name]);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  const [tool] = await createProductionAgentTools({ ...agent, mcp: [{ ...server, env: declared }] }, { current: "unset" });
  assert.deepEqual((await tool!.execute("call", {}, undefined, undefined, {} as never)).details, { LC_ALL: process.env.LC_ALL ?? "C" });
});
test("a conflicting declaration refuses startup before any MCP server can spawn", async (t) => {
  const { agent } = await fixture(t);
  for (const name of observedKeys.filter((name) => name !== "LC_ALL")) {
    await assert.rejects(createProductionAgentTools({ ...agent, mcp: [{ name: "bad", transport: "stdio", command: "/must-not-launch", args: [], env: { [name]: "conflict" }, tools: [] }] }), new RegExp(`conflicts with ${name}`));
  }
  process.env.NOOPOLIS_TASK_CLOCK = "broken";
  await assert.rejects(createProductionAgentTools(agent), /NOOPOLIS_TASK_CLOCK/u);
});
test("Moltnet children inherit derived variables; receipt replay converts time while historical read payloads stay intact", async (t) => {
  const { agent, root } = await fixture(t);
  const cli = path.join(root, "moltnet"), observed = path.join(root, "child-clock.json");
  await writeFile(cli, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(observed)},JSON.stringify(Object.fromEntries(${JSON.stringify(observedKeys)}.map(k=>[k,process.env[k]]))));import(${JSON.stringify(pathToFileURL(path.resolve("src/runtime/fixtures/testMoltnetMachine.mjs")).href)});\n`);
  await chmod(cli, 0o700);
  const tools = await createProductionAgentTools({ ...agent, moltnet: { cliPath: cli, configPath: path.join(root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } }, { current: "wake" });
  const call = () => tools[0]!.execute("send", { network: "news", target: "room:desk", text: "hello" }, undefined, undefined, {} as never);
  await call();
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), expected);
  const receiptFile = path.join(root, "tool-state", (await readdir(path.join(root, "tool-state")))[0]!);
  const stored = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.ok(Math.abs(Date.parse(stored.at) - Date.now()) < 5000, "receipt bookkeeping stays real");
  const replay = await call();
  assert.equal((replay.details as { at: string }).at, new Date(readTaskClock()!.at(Date.parse(stored.at))).toISOString());
  const history = [{ id: "old", created_at: "2001-01-01T00:00:00Z", parts: [{ kind: "text", text: "archive" }] }];
  const corpus = path.join(root, "corpus.json"); await writeFile(corpus, JSON.stringify({ "room:desk": history }));
  process.env.DAIMON_TEST_MOLTNET_CORPUS = corpus;
  const read = await tools[1]!.execute("read", { network: "news", target: "room:desk" }, undefined, undefined, {} as never);
  assert.deepEqual((read.details as { messages: unknown }).messages, history);
});
