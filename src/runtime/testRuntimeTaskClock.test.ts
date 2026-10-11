import { readyTaskClockEnvironment, resetTaskClockProcessForTest } from "./taskClockProcess.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { createScriptedMcpActions } from "./testRuntimeMcpActions.js";
import { createScriptedMoltnetActions } from "./testRuntimeMoltnetActions.js";

const reserved = ["NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "MNEME_CLOCK_ANCHOR_MS", "MNEME_CLOCK_FUTURE", "FAKETIME", "FAKETIME_SKIP_CMDS", "FAKETIME_ONLY_CMDS", "FAKETIME_FUTURE", "DYLD_INSERT_LIBRARIES", "DYLD_FUTURE", "LD_PRELOAD"];
const expected = { FAKETIME: "-843385600.250", FAKETIME_DONT_FAKE_MONOTONIC: "1", LD_PRELOAD: "/caller/libfaketime.so.1" };
async function fixture(t: TestContext) {
  const previous = process.env;
  process.env = { ...previous, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00.000Z", anchorEpochMs: 1821692800250 }), LD_PRELOAD: expected.LD_PRELOAD, MNEME_CLOCK_ORIGIN: "stale", FAKETIME_SKIP_CMDS: "node", DAIMON_TEST_MCP_TOOLS: "task_clock" };
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-scripted-clock-"));
  t.after(async () => { process.env = previous; await rm(root, { recursive: true, force: true }); });
  resetTaskClockProcessForTest();
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => { Object.defineProperty(process, "platform", platform); resetTaskClockProcessForTest(); });
  // Environment propagation only; the Linux integration test covers real interposition.
  readyTaskClockEnvironment({}, undefined, (_command, _args, env) => String(Math.floor((Date.now() + Number(env.FAKETIME) * 1000) / 1000)));
  const observed = path.join(root, "observed.json");
  const capture = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:NOOPOLIS_TASK_CLOCK$|MNEME_CLOCK_|FAKETIME|DYLD_|LD_PRELOAD$)/.test(name)))));`;
  return { root, observed, capture };
}

test("scripted MCP startup rejects all declared clock controls and its child has one offset owner", async (t) => {
  const { root, observed, capture } = await fixture(t);
  const command = path.join(root, "mcp.mjs"), config = path.join(root, "mcp.json"), receipt = path.join(root, "receipt.json");
  await writeFile(command, `${capture}\nawait import(${JSON.stringify(pathToFileURL(path.resolve("src/runtime/fixtures/testMcpServer.mjs")).href)});`);
  const actions = [{ type: "mcp_call", trigger: { agent_id: "a", wake_kind: "manual", text_sha256: createHash("sha256").update("work").digest("hex") }, server_id: "clock", tool: "task_clock", arguments: {} }];
  const prepare = async (names: string[]) => {
    const bytes = JSON.stringify({ version: "spawnfile.explicit-test-mcp.v1", compile_fingerprint: "sf1:0123456789ab", servers: [{ id: "clock", agent_id: "a", command: process.execPath, args: [command], tools: ["task_clock"], env_names: names }] });
    await writeFile(config, bytes);
    await writeFile(receipt, JSON.stringify({ version: "spawnfile.explicit-test-mcp-receipt.v1", artifact_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
    return createScriptedMcpActions(actions, config, receipt);
  };
  for (const name of reserved) await assert.rejects(prepare([name]), new RegExp(`conflicts with ${name}`));
  const run = await prepare(["DAIMON_TEST_MCP_TOOLS"]);
  const result = await run({ agentId: "a", event: { id: "wake", kind: "manual", text: "work" } });
  assert.equal(result.length, 1); assert.equal(result[0]!.is_error, false);
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), expected);
});

test("scripted Moltnet children discard inherited offset variables and process controls", async (t) => {
  const { root, observed, capture } = await fixture(t);
  const command = path.join(root, "moltnet.mjs"), config = path.join(root, "client.json");
  await writeFile(command, `#!${process.execPath}\n${capture}\nconsole.log(JSON.stringify({accepted:true,message_id:'one'}));`);
  await chmod(command, 0o700);
  await writeFile(config, JSON.stringify({ version: "moltnet.client.v1", attachments: [{ network_id: "news", rooms: [{ id: "desk" }] }] }));
  const run = await createScriptedMoltnetActions([{ delivery_id: "moltnet:one", network_id: "news", target: "room:desk", text: "work" }], command, config);
  assert.equal((await run("moltnet:one"))[0]!.message_id, "one");
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), expected);
});
