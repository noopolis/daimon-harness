import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentHandle } from "../core/types.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import type { OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";

const env = "DAIMON_RECORDING_ADMISSION_TEST";
const wake = (agentId: string, id: string): OrganizationRuntimeWakeRequest => ({ token: "token", agentId,
  event: { version: "noopolis.daimon.wake.v1", id, kind: "manual", text: "work", occurredAt: new Date().toISOString() } });

test("recording accepts only durable admission through direct and control hosts; plain agents stay unchanged", { timeout: 5000 }, async (t) => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "recording-admission-"));
  const directory = path.join(root, "recording"), inbox = path.join(root, "inbox");
  await mkdir(directory, { mode: 0o700 }); await mkdir(inbox, { mode: 0o700 });
  process.env[env] = "token";
  const config = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: env },
    agents: [true, false].map((recording) => ({ id: recording ? "recorded" : "plain", name: "Agent", instructions: "Work",
      workspacePath: path.join(root, recording ? "recorded-workspace" : "plain-workspace"), runtimeHomePath: path.join(root, recording ? "recorded-home" : "plain-home"), engine: { kind: "codex" },
      ...(recording ? { recording: { directory, keepMs: 100000, snapshots: [] } } : {}) })) };
  const turns: string[] = [];
  let reached!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { reached = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const core = createOrganizationRuntimeHostForTest(config, async (agent): Promise<AgentHandle> => ({
    id: agent.id, status: () => ({ agentId: agent.id, state: "idle" }), stop: async () => { release(); },
    wake: async (event) => {
      turns.push(event.id);
      if (agent.recording) {
        const row = JSON.parse(await readFile(path.join(directory, "wake-moments.jsonl"), "utf8"));
        assert.equal(row.execution_id, event.id); reached(); await held;
      }
      return { agentId: agent.id, text: "done", durationMs: 1 };
    }
  }));
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: inbox, controlToken: "token",
    storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true } });
  t.after(async () => { release(); await control.stop(); delete process.env[env]; await rm(root, { recursive: true, force: true }); });
  await control.start();
  for (const host of [core, control]) {
    const result = await host.wake(wake("recorded", "legacy"));
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.equal(result.code, "durable_inbox_required");
  }
  assert.deepEqual(turns, []);
  assert.equal((await core.wake(wake("plain", "direct-plain"))).status, "completed");
  assert.equal((await control.wake(wake("plain", "control-plain"))).status, "completed");
  assert.equal((await control.accept({ token: "token", agent_id: "recorded", delivery_id: "durable", event: {
    version: "noopolis.daimon.wake.v2", kind: "message", text: "Work", occurred_at: new Date().toISOString()
  } })).state, "accepted");
  await started;
  const overlap = await core.wake(wake("recorded", "overlap"));
  assert.equal(overlap.status, "rejected");
  if (overlap.status === "rejected") assert.equal(overlap.code, "durable_inbox_required");
  assert.deepEqual(turns, ["direct-plain", "control-plain", "durable"]);
  release();
});
