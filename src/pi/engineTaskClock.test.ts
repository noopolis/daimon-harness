import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { codexTaskClockArgs, grokTaskClockConfig, reportEngineTaskClockGap } from "./engineTaskClock.js";
import { renderCodexArgs } from "./cliEngineSpawn.js";
import { registerGrokHomeMcpServer } from "./grokHomeMcpRegistration.js";
import { renderGrokLeanBaseConfig } from "../runtime/grokBrokerWorkerConfig.js";

const expectedSet = '{"FAKETIME"="-843385600.250","FAKETIME_DONT_FAKE_MONOTONIC"="1","LC_ALL"="C","LD_PRELOAD"="/caller/libfaketime.so.1"}';
const expectedPolicy = `{inherit="all",ignore_default_excludes=false,exclude=[],include_only=[],set=${expectedSet}}`;
function clock(t: TestContext) {
  const previous = process.env;
  process.env = { ...previous, NOOPOLIS_TASK_CLOCK: '{"version":"noopolis.task-clock.v1","origin":"2001-01-01T00:00:00Z","anchorEpochMs":1821692800250}', LD_PRELOAD: "/caller/libfaketime.so.1", FAKETIME: "stale", FAKETIME_SKIP_CMDS: "bash" };
  t.after(() => { process.env = previous; });
}

test("Codex receives the exact derived shell policy through argv in both sandbox modes", (t) => {
  clock(t);
  const expected = ["-c", `shell_environment_policy=${expectedPolicy}`];
  assert.deepEqual(codexTaskClockArgs(), expected);
  for (const codexSandbox of [undefined, { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } as const]) {
    const args = renderCodexArgs({ codexSandbox }, "/workspace", "http://127.0.0.1:1234/mcp");
    assert.deepEqual(args.slice(-3), [...expected, "-"]);
    assert.equal(args.filter((value) => value.startsWith("shell_environment_policy=")).length, 1);
    assert.doesNotMatch(args.join("\n"), /FAKETIME_SKIP_CMDS|NOOPOLIS_TASK_CLOCK|MNEME_CLOCK/u);
  }
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.deepEqual(codexTaskClockArgs(), []);
  assert.ok(!renderCodexArgs({}, "/workspace", undefined).some((value) => value.includes("shell_environment_policy")));
});

test("direct Grok writes the exact tool-child policy into its private home, then removes it", async (t) => {
  clock(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-clock-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const policy = `shell_environment_policy = ${expectedPolicy}\n`;
  assert.equal(grokTaskClockConfig(), policy);
  const registration = await registerGrokHomeMcpServer({ engineHomePath: home, endpoint: "http://127.0.0.1:1234/mcp" });
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), `${policy}${renderGrokLeanBaseConfig()}[mcp_servers.daimon]\nurl = "http://127.0.0.1:1234/mcp"\n`);
  await registration.close();
  assert.equal(await readFile(path.join(home, "config.toml"), "utf8"), renderGrokLeanBaseConfig());
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.equal(grokTaskClockConfig(), "");
});

test("clock coverage gaps are explicit non-fatal readiness diagnostics", (t) => {
  clock(t);
  const warning = t.mock.method(console, "warn", () => {});
  reportEngineTaskClockGap("agy"); reportEngineTaskClockGap("grok", true);
  assert.equal(warning.mock.callCount(), 2);
  assert.match(warning.mock.calls[0]!.arguments[0], /engine=agy.*native tools remain on real time; wake allowed/u);
  assert.match(warning.mock.calls[1]!.arguments[0], /engine=grok.*attested broker worker config.*wake allowed/u);
  reportEngineTaskClockGap("codex"); reportEngineTaskClockGap("grok");
  delete process.env.NOOPOLIS_TASK_CLOCK;
  reportEngineTaskClockGap("agy"); reportEngineTaskClockGap("grok", true);
  assert.equal(warning.mock.callCount(), 2);
});
