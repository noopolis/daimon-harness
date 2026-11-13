import assert from "node:assert/strict";
import test from "node:test";

import { renderAgyArgs } from "./cliEngineSpawn.js";
import {
  DAIMON_MCP_SERVER_NAME,
  renderAgyMcpAddArgs,
  renderAgyMcpRemoveArgs
} from "./cliMcpRegistration.js";

test("AGY registers the per-wake endpoint as an http server, flags before the name", () => {
  const args = renderAgyMcpAddArgs([], "http://127.0.0.1:54321/mcp");
  assert.deepEqual(args, ["mcp", "add", "--type", "http", DAIMON_MCP_SERVER_NAME, "http://127.0.0.1:54321/mcp"]);
  // `agy mcp add` rejects a flag placed after <name>; the endpoint is last.
  assert.equal(args.indexOf(DAIMON_MCP_SERVER_NAME) > args.indexOf("--type"), true);
  assert.deepEqual(renderAgyMcpRemoveArgs([]), ["mcp", "remove", DAIMON_MCP_SERVER_NAME]);
});

test("AGY always runs headless in the metered stream format with tool approval", () => {
  assert.deepEqual(renderAgyArgs({ timeoutMs: 180_000 }, "PROMPT", false), [
    "--print", "PROMPT",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout", "180000ms"
  ]);
  assert.deepEqual(renderAgyArgs({}, "PROMPT", true).includes("--sandbox"), true);
  assert.deepEqual(renderAgyArgs({}, "PROMPT", false).includes("--sandbox"), false);
});

test("AGY's permission, output-format and continuity flags are Daimon-owned", () => {
  for (const injected of [
    "--dangerously-skip-permissions",
    "--sandbox",
    "--output-format=text",
    "--print",
    "--continue",
    "-c",
    "--conversation",
    "--mode"
  ]) {
    assert.throws(
      () => renderAgyArgs({ commandArgs: [injected] }, "PROMPT", false),
      /AGY security-boundary arguments are Daimon-owned/u,
      injected
    );
  }
  assert.deepEqual(renderAgyArgs({ commandArgs: ["--effort", "high"] }, "P", false).slice(0, 2), ["--effort", "high"]);
});

test("an AGY turn with Daimon tools may read its own MCP tool schemas, and nothing else of its home", async () => {
  const { agyPiHooks } = await import("../engines/agy/piHooks.js");
  const plan = (endpoint: string | undefined) => agyPiHooks.spawnPlan({ engine: "agy" }, "PROMPT", { cwd: "/workspace", runtimeHomePath: "/homes/agent" }, endpoint).args;
  const withTools = plan("http://127.0.0.1:4321/mcp");
  assert.deepEqual(withTools.slice(withTools.indexOf("--add-dir")), ["--add-dir", "/homes/agent/.gemini/antigravity-cli/mcp"]);
  assert.equal(plan(undefined).includes("--add-dir"), false);
});
