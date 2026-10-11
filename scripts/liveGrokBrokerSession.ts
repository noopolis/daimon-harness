import assert from "node:assert/strict";
import { spawn } from "../src/runtime/taskClockProcess.ts";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readChild } from "../src/pi/cliChildOutput.ts";
import { terminateChild, trackCliChild } from "../src/pi/cliProcess.ts";
import { decodeGrokHeadlessTurn } from "../src/pi/grokHeadlessResult.ts";
import { readGrokBrokerCredential } from "../src/runtime/grokBrokerCredentialReader.ts";
import { DEFAULT_GROK_BROKER_TURN_LIMITS } from "../src/runtime/engineBrokerTurnAccounting.ts";
import { startGrokBrokerProxy } from "../src/runtime/grokBrokerProxy.ts";
import { GrokBrokerTurnMeter } from "../src/runtime/grokBrokerTurnMeter.ts";
import { DEFAULT_GROK_BROKER_MODEL_POLICY } from "../src/runtime/grokBrokerModelPolicy.ts";
import { GROK_BROKER_PROVIDER_CAPABILITY_ENV, renderGrokBrokerWorkerArgs, renderGrokBrokerWorkerConfigWith } from "../src/runtime/grokBrokerWorkerConfig.ts";

// Explicit live auth/transport check, not the Linux native worker/isolation E2E.
// Read the operator credential only in this process; never stage or rotate it.
const authFile = path.join(process.env.GROK_HOME ?? path.join(os.homedir(), ".grok"), "auth.json");
const root = await mkdtemp(path.join(os.tmpdir(), "daimon-live-grok-"));
const sentinel = "GROK_DAIMON_AUTH_OK";
const authority = {
  async accessToken(forceRefresh: boolean): Promise<string> {
    if (forceRefresh) throw new Error("Live probe requires a current Grok login");
    return (await readGrokBrokerCredential(authFile)).accessToken;
  },
  async markRejected(): Promise<void> { throw new Error("Live probe requires a current Grok login"); },
};
let stage = "credential preflight";

try {
  await authority.accessToken(false);
  for (let round = 1; round <= 2; round += 1) {
    stage = `broker start ${round}`;
    const proxy = await startGrokBrokerProxy(authority);
    try {
      const home = path.join(root, `worker-${round}`);
      await mkdir(home, { mode: 0o700 });
      const turnId = `local-probe-${round}`;
      const capability = proxy.capabilities.issue("local-auth-probe", turnId);
      // This local transport probe deliberately does not attest a native worker.
      proxy.registerIsolationGuard(turnId, async () => undefined);
      // The proxy forwards nothing unmetered; the probe runs under the default v1 limits.
      proxy.registerTurn(turnId, { policy: DEFAULT_GROK_BROKER_MODEL_POLICY, meter: new GrokBrokerTurnMeter(DEFAULT_GROK_BROKER_TURN_LIMITS) });
      // No MCP tools are needed for this exact-reply authentication probe.
      await writeFile(path.join(home, "config.toml"), renderGrokBrokerWorkerConfigWith(DEFAULT_GROK_BROKER_MODEL_POLICY, { proxyPort: proxy.port, mcpUrl: "http://127.0.0.1:43124/mcp" }).split("[mcp_servers.daimon]")[0]);
      const prompt = path.join(home, "prompt.txt");
      await writeFile(prompt, `Reply exactly ${sentinel}. Do not use tools.`);
      stage = `model turn ${round}`;
      // The proxy only forwards the lean worker request shape (pinned client
      // version, exact tool set, declared effort), so the probe uses the same
      // argv as the native launcher with the built-in strict profile.
      const args = [...renderGrokBrokerWorkerArgs(prompt, home)].map((value) => value === "daimon-strict" ? "strict" : value);
      args[args.indexOf("--max-turns") + 1] = "1";
      const child = trackCliChild(spawn("grok", args, {
        cwd: home, detached: process.platform !== "win32",
        env: { PATH: process.env.PATH, HOME: home, GROK_HOME: home, LANG: "C", LC_ALL: "C", TZ: "UTC", [GROK_BROKER_PROVIDER_CAPABILITY_ENV]: capability },
        stdio: ["ignore", "pipe", "pipe"],
      }));
      let output: string;
      try { output = await readChild(child, 90_000, [capability], { retainStdoutTail: true }); }
      finally { await terminateChild(child); }
      stage = `terminal verification ${round}`;
      const turn = decodeGrokHeadlessTurn(output);
      assert.equal(turn.text, sentinel);
      const usage = turn.usage;
      assert.ok(usage !== undefined && usage.total > 0, "Expected real provider usage");
      await assert.rejects(access(path.join(home, "auth.json")), { code: "ENOENT" });
      process.stdout.write(`${JSON.stringify({ round, reply: sentinel, usage })}\n`);
    } finally { await proxy.close(); }
  }
  process.stdout.write("GROK_BROKER_AUTH_RESTART_OK\n");
} catch {
  // Never echo provider errors, subprocess output, or credential paths.
  process.stderr.write(`Grok live broker probe failed during ${stage}. Check the local Grok login and CLI version.\n`);
  process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
