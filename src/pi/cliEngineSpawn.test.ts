import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readChild } from "./cliSession.js";
import { GROK_STRICT_SANDBOX_PROFILE, renderCodexArgs, renderCodexPermissionProfile, renderGrokSandboxArgs, spawnEngine } from "./cliEngineSpawn.js";

test("autonomous Codex and Grok launches omit wall-clock and turn caps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-unbounded-cli-"));
  const command = path.join(root, "engine");
  await writeFile(command, "#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='mcp')process.stdout.write('ok');else{for await(const c of process.stdin){}process.stdout.write(JSON.stringify(a));}\n");
  await chmod(command, 0o700);
  try {
    for (const engine of ["codex", "grok"] as const) {
      const options = engine === "grok"
        ? { engine, command, commandArgs: ["--deny", "Bash(rm *)"], maxToolTurns: 1 }
        : { engine, command };
      const child = spawnEngine(options, "probe", { cwd: root }, "http://127.0.0.1:1234/mcp");
      const args = JSON.parse(await readChild(child, 10_000, [])) as string[];
      assert.equal(args.includes("--max-turns"), false);
      assert.equal(args.includes("--print-timeout"), false);
      if (engine === "grok") {
        assert.ok(args.includes("--always-approve"));
        assert.deepEqual(args.slice(0, 2), ["--deny", "Bash(rm *)"]);
        assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", GROK_STRICT_SANDBOX_PROFILE]);
        assert.ok(args.includes("--no-subagents"));
        assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "streaming-messages-json"]);
        assert.equal(args.includes("--json-schema"), false);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex output, sandbox, config, and cwd boundaries reject caller overrides", () => {
  for (const injected of [
    "--json", "--sandbox", "--sandbox=read-only", "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message", "-c", "--config", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "-C", "--cd"
  ]) {
    assert.throws(() => renderCodexArgs({ commandArgs: [injected] }, "/workspace", undefined), /Daimon-owned/u);
  }
  const args = renderCodexArgs({ commandArgs: ["--effort", "high"] }, "/workspace", undefined);
  assert.deepEqual(args.slice(0, 2), ["--effort", "high"]);
  assert.equal(args.includes("--json"), true);
});

for (const mode of ["standalone", "strict"] as const) {
  test(`Codex ${mode} launch requires the per-wake MCP server`, () => {
    const args = renderCodexArgs(mode === "standalone" ? {} : {
      codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" }
    }, "/workspace", "http://127.0.0.1:1/mcp");
    assert.deepEqual(args.slice(-5), ["-c", "mcp_servers.daimon.enabled=true", "-c", "mcp_servers.daimon.required=true", "-"]);
  });
}

test("codex argv preserves model defaults while requiring the per-wake MCP server", () => {
  const args = renderCodexArgs({ commandArgs: [] }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(args, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "mcp_servers.daimon.enabled=true", "-c", "mcp_servers.daimon.required=true", "-"]);
});

test("codex strict policy is rendered as per-turn Daimon-owned CLI config", () => {
  const args = renderCodexArgs({
    commandArgs: [],
    codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
    codexSandboxProtectedPaths: ["/runtime/agent/.codex/auth.json", "/runtime/agent/.daimon-inbound", "/proc", "/run", "/runtime/peer"],
    codexSandboxReadablePaths: ["/runtime/agent/tool-output"]
  }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.equal(args.includes("--sandbox"), false);
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.includes("web_search=\"disabled\""));
  assert.ok(args.includes("default_permissions=\"daimon-strict\""));
  assert.ok(args.some((arg) => arg === 'permissions={"daimon-strict"={"extends"=":workspace","filesystem"={":workspace_roots"={"."="write"},"/runtime/agent/tool-output"="read","/runtime/agent/.codex/auth.json"="deny","/runtime/agent/.daimon-inbound"="deny","/proc"="deny","/run"="deny","/runtime/peer"="deny"},"network"={"enabled"=false}}}'));
  assert.ok(args.includes("approval_policy=\"never\""));
  assert.ok(args.some((arg) => arg.includes("mcp_servers={daimon={url=\"http://127.0.0.1:1/mcp\",enabled=true,default_tools_approval_mode=\"approve\"}}")));
  for (const injected of ["--profile", "--profile=weak", "--permissions-profile", "--permissions-profile=weak", "-p", "-P", "--enable", "--disable", "--add-dir", "--search", "default_permissions=\":danger-full-access\"", "permissions.weak.extends=\":danger-full-access\""]) {
    assert.throws(() => renderCodexArgs({ commandArgs: [injected], codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } }, "/workspace", "http://127.0.0.1:1/mcp"), /Daimon-owned/u);
  }
});

test("Codex renderer rejects a weak policy even when bypassing the parser", () => {
  assert.throws(() => renderCodexArgs({ commandArgs: [], codexSandbox: { mode: "danger-full-access", networkAccess: true, webSearch: "enabled" } as never }, "/workspace", "http://127.0.0.1:1/mcp"), /sandbox policy/u);
});

test("isolated Codex trials can disable ambient instructions only under strict policy", () => {
  const strict = { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const;
  const baseline = renderCodexArgs({ codexSandbox: strict }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.equal(baseline.includes("project_doc_max_bytes=0"), false);
  const isolated = renderCodexArgs({ codexSandbox: strict, codexProjectDocMaxBytes: 0 }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.ok(isolated.includes("project_doc_max_bytes=0"));
  assert.equal(isolated.filter((arg) => arg === "project_doc_max_bytes=0").length, 1);
  assert.equal(isolated[isolated.indexOf("project_doc_max_bytes=0") - 1], "-c");
  for (const setting of ["features.apps=false", "features.plugins=false", "mcp_servers.daimon.enabled=true", "mcp_servers.daimon.required=true"]) {
    assert.ok(isolated.includes(setting));
  }
  assert.throws(() => renderCodexArgs({ codexProjectDocMaxBytes: 0, codexSandbox: { ...strict, networkAccess: true } as never }, "/workspace", undefined), /sandbox policy/u);
  assert.throws(() => renderCodexArgs({ codexProjectDocMaxBytes: 0 }, "/workspace", undefined), /strict policy/u);
  assert.throws(() => renderCodexArgs({ codexSandbox: strict, codexProjectDocMaxBytes: 1 as never }, "/workspace", undefined), /zero byte limit/u);
});

test("codex strict policy defeats a weakening process environment", () => {
  const previous = process.env.DAIMON_CODEX_SANDBOX;
  try {
    process.env.DAIMON_CODEX_SANDBOX = "danger-full-access";
    const args = renderCodexArgs({ commandArgs: [], codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } }, "/workspace", "http://127.0.0.1:1/mcp");
    assert.equal(args.includes("--sandbox"), false);
    assert.ok(args.includes("default_permissions=\"daimon-strict\""));
  } finally {
    if (previous === undefined) delete process.env.DAIMON_CODEX_SANDBOX;
    else process.env.DAIMON_CODEX_SANDBOX = previous;
  }
});

test("strict Codex policy cannot be overridden by the renderer sandbox argument", () => {
  const args = renderCodexArgs({ commandArgs: [], codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } }, "/workspace", "http://127.0.0.1:1/mcp", "danger-full-access");
  assert.equal(args.includes("--sandbox"), false);
  assert.ok(args.includes("default_permissions=\"daimon-strict\""));
});

test("captured Codex spawn argv carries the strict policy on a real turn launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-codex-policy-argv-"));
  const command = path.join(root, "engine");
  await writeFile(command, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  await chmod(command, 0o700);
  try {
    const child = spawnEngine({
      engine: "codex",
      command,
      codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" },
      codexSandboxProtectedPaths: [path.join(root, ".codex", "auth.json")],
      codexSandboxReadablePaths: [path.join(root, "tool-output")]
    }, "probe", { cwd: root }, "http://127.0.0.1:1/mcp");
    const args = JSON.parse(await readChild(child, 10_000, [])) as string[];
    assert.equal(args.includes("--sandbox"), false);
    assert.ok(args.includes("-c") && args.includes("default_permissions=\"daimon-strict\""));
    assert.ok(args.some((arg) => arg.includes(`${path.join(root, ".codex", "auth.json")}"="deny"`)));
    assert.ok(args.some((arg) => arg.includes(`${path.join(root, "tool-output")}"="read"`)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex permission profile lets protected denies override readable paths", () => {
  const rendered = renderCodexPermissionProfile("daimon-strict", ["/runtime/agent/.codex"], ["/runtime/agent/tool-output", "/runtime/agent/.codex"]);
  assert.match(rendered, /"\/runtime\/agent\/tool-output"="read"/u);
  assert.match(rendered, /"\/runtime\/agent\/\.codex"="deny"/u);
});

test("codex argv renders -m for a pinned model and leaves everything else untouched", () => {
  const args = renderCodexArgs({ commandArgs: [], model: "gpt-5-codex" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(args, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--model=gpt-5-codex", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "mcp_servers.daimon.enabled=true", "-c", "mcp_servers.daimon.required=true", "-"]);
});

test("codex argv renders both model and reasoningEffort together in stable order", () => {
  const args = renderCodexArgs({ commandArgs: [], model: "gpt-5-codex", reasoningEffort: "xhigh" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.deepEqual(args, ["exec", "--sandbox", "danger-full-access", "--skip-git-repo-check", "--model=gpt-5-codex", "-c", "model_reasoning_effort=xhigh", "--color", "never", "--json", "-C", "/workspace",
    "-c", "mcp_servers.daimon.url=http://127.0.0.1:1/mcp", "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "mcp_servers.daimon.enabled=true", "-c", "mcp_servers.daimon.required=true", "-"]);
});

test("codex argv renders reasoningEffort alone without a model flag", () => {
  const args = renderCodexArgs({ commandArgs: [], reasoningEffort: "low" }, "/workspace", "http://127.0.0.1:1/mcp");
  assert.equal(args.includes("--model=gpt-5-codex"), false);
  assert.deepEqual(args.slice(args.indexOf("-c"), args.indexOf("-c") + 2), ["-c", "model_reasoning_effort=low"]);
});

test("Grok's kernel sandbox authority cannot be weakened by injected CLI arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-boundary-"));
  try {
    for (const commandArgs of [["--sandbox", "off"], ["--sandbox=workspace"], ["--permission-mode", "bypassPermissions"]]) {
      assert.throws(() => spawnEngine({ engine: "grok", command: process.execPath, commandArgs }, "probe", { cwd: root }, undefined), /Daimon-owned/u);
    }
    assert.deepEqual(renderGrokSandboxArgs(undefined, "daimon-strict"), ["--sandbox", "daimon-strict"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
