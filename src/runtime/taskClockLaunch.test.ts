import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createCliSessionFactory } from "../pi/cliSession.js";
import { createProductionAgentTools } from "./productionAgentTools.js";
import { createScriptedMcpActions } from "./testRuntimeMcpActions.js";
import { createScriptedMoltnetActions } from "./testRuntimeMoltnetActions.js";
import { resetTaskClockProcessForTest } from "./taskClockProcess.js";

async function fixture(t: TestContext) {
  const previous = process.env;
  process.env = { ...previous };
  delete process.env.NOOPOLIS_TASK_CLOCK;
  resetTaskClockProcessForTest();
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-launch-clock-"));
  t.after(async () => { process.env = previous; resetTaskClockProcessForTest(); await rm(root, { recursive: true, force: true }); });
  const marker = path.join(root, "launched"), command = path.join(root, "child.mjs");
  const capture = `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'launched');`;
  const agent = { id: "a", name: "A", instructions: "test", workspacePath: root, runtimeHomePath: root, engine: { kind: "codex" as const } };
  const server = { name: "clock", transport: "stdio" as const, command: process.execPath, args: [command], env: { DAIMON_TEST_MCP_TOOLS: "task_clock" }, tools: ["task_clock"] };
  return {
    root, marker, command, capture, agent, server,
    clock(preload: string | undefined) {
      // A near-zero offset must still prove interposition independently.
      const now = Date.now();
      process.env.NOOPOLIS_TASK_CLOCK = JSON.stringify({ version: "noopolis.task-clock.v1", origin: new Date(now).toISOString(), anchorEpochMs: now });
      if (preload === undefined) delete process.env.LD_PRELOAD; else process.env.LD_PRELOAD = preload;
    },
    async mcp() { await writeFile(command, `${capture}\nawait import(${JSON.stringify(pathToFileURL(path.resolve("src/runtime/fixtures/testMcpServer.mjs")).href)});`); }
  };
}
const missingLibrary = "/definitely-missing/libfaketime.so.1";
const refused = /NOOPOLIS_TASK_CLOCK:.*refusing clocked execution/u;

for (const engine of ["codex", "grok", "agy"] as const) {
  test(`standalone ${engine} CLI sessions reach their MCP mount without clock interposition`, async (t) => {
    const rig = await fixture(t); rig.clock(missingLibrary);
    let mounted = false;
    const { session } = await createCliSessionFactory({ engine, command: rig.command, onToolsMounted: () => { mounted = true; throw new Error("mount reached"); } })({ cwd: rig.root } as never);
    try { await assert.rejects(session.prompt("work"), /mount reached/u); assert.equal(mounted, true); }
    finally { await session.dispose(); }
    await assert.rejects(access(rig.marker), /ENOENT/u);
  });
}

test("production MCP discovery refuses before a stdio server launches", async (t) => {
  const rig = await fixture(t); await rig.mcp(); rig.clock(missingLibrary);
  await assert.rejects(createProductionAgentTools({ ...rig.agent, mcp: [rig.server] }), refused);
  await assert.rejects(access(rig.marker), /ENOENT/u);
});

test("production MCP tool calls recheck readiness at their own launch boundary", async (t) => {
  const rig = await fixture(t); await rig.mcp();
  const [tool] = await createProductionAgentTools({ ...rig.agent, mcp: [rig.server] }, { current: "wake" });
  await access(rig.marker); await rm(rig.marker); rig.clock(missingLibrary);
  await assert.rejects(tool!.execute("call", {}, undefined, undefined, {} as never), refused);
  await assert.rejects(access(rig.marker), /ENOENT/u);
});

test("production Moltnet children refuse without interposition", async (t) => {
  const rig = await fixture(t);
  await writeFile(rig.command, `#!${process.execPath}\n${rig.capture}\nprocess.exit(0);`); await chmod(rig.command, 0o700);
  const [tool] = await createProductionAgentTools({ ...rig.agent, moltnet: { cliPath: rig.command, configPath: path.join(rig.root, "config.json"), networks: [{ id: "news", rooms: ["desk"], dms: false }] } }, { current: "wake" });
  rig.clock(missingLibrary);
  await assert.rejects(tool!.execute("send", { network: "news", target: "room:desk", text: "work" }, undefined, undefined, {} as never), refused);
  await assert.rejects(access(rig.marker), /ENOENT/u);
});

test("scripted MCP children refuse without interposition", async (t) => {
  const rig = await fixture(t); await rig.mcp();
  const config = path.join(rig.root, "mcp.json"), receipt = path.join(rig.root, "receipt.json");
  const bytes = JSON.stringify({ version: "spawnfile.explicit-test-mcp.v1", compile_fingerprint: "sf1:0123456789ab", servers: [{ id: "clock", agent_id: "a", command: process.execPath, args: [rig.command], tools: ["task_clock"], env_names: ["DAIMON_TEST_MCP_TOOLS"] }] });
  await writeFile(config, bytes); await writeFile(receipt, JSON.stringify({ version: "spawnfile.explicit-test-mcp-receipt.v1", artifact_sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }));
  const run = await createScriptedMcpActions([{ type: "mcp_call", trigger: { agent_id: "a", wake_kind: "manual", text_sha256: createHash("sha256").update("work").digest("hex") }, server_id: "clock", tool: "task_clock", arguments: {} }], config, receipt);
  process.env.DAIMON_TEST_MCP_TOOLS = "task_clock"; rig.clock(missingLibrary);
  await assert.rejects(run({ agentId: "a", event: { id: "wake", kind: "manual", text: "work" } }), refused);
  await assert.rejects(access(rig.marker), /ENOENT/u);
});

test("scripted Moltnet children refuse without interposition", async (t) => {
  const rig = await fixture(t), config = path.join(rig.root, "moltnet.json");
  await writeFile(config, JSON.stringify({ version: "moltnet.client.v1", attachments: [{ network_id: "news", rooms: [{ id: "desk" }] }] }));
  await writeFile(rig.command, `#!${process.execPath}\n${rig.capture}\nconsole.log(JSON.stringify({accepted:true,message_id:'one'}));`); await chmod(rig.command, 0o700);
  const run = await createScriptedMoltnetActions([{ delivery_id: "moltnet:one", network_id: "news", target: "room:desk", text: "work" }], rig.command, config);
  rig.clock(missingLibrary);
  await assert.rejects(run("moltnet:one"), refused);
  await assert.rejects(access(rig.marker), /ENOENT/u);
});
