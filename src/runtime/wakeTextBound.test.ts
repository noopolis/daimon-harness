import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ORGANIZATION_RUNTIME_VERSION, parseOrganizationRuntimeConfig, type OrganizationRuntimeHost, type OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { createOrganizationRuntimeHost } from "./organizationRuntimeHost.js";

const token = "wake-text-secret";
const judge = "x".repeat(22_082);
const config = (maxWakeTextBytes?: number) => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_WAKE_TEXT_TEST_TOKEN", ...(maxWakeTextBytes === undefined ? {} : { maxWakeTextBytes }) },
  agents: [{ id: "judge", name: "Judge", instructions: "Judge.", workspacePath: "/runtime/workspace", runtimeHomePath: "/runtime/home", engine: { kind: "codex" as const } }]
});
const acceptance = (text: string) => ({ token, agent_id: "judge", delivery_id: "judgment-1", event: { version: "noopolis.daimon.wake.v2", kind: "manual" as const, text, occurred_at: "2026-11-04T00:00:00.000Z" } });
const storeOptions = { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true };

class RecordingCore implements Pick<OrganizationRuntimeHost, "start" | "wake" | "health" | "stop" | "activity"> {
  readonly wakes: OrganizationRuntimeWakeRequest[] = [];
  async start(): Promise<void> {}
  async wake(request: OrganizationRuntimeWakeRequest) {
    this.wakes.push(request);
    return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text: "{}", durationMs: 1 } as const;
  }
  async health() { return { version: "noopolis.daimon.organization-runtime-health.v1" as const, state: "running" as const, agents: [] }; }
  async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1" as const, items: [] }; }
  async stop() { return { version: "noopolis.daimon.organization-runtime-stop.v1" as const, state: "stopped" as const }; }
}

test("an organization's declared wake text bound admits a whole judgment the default refuses", async () => {
  for (const [declared, admitted] of [[undefined, false], [196_608, true]] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-text-"));
    await chmod(root, 0o700);
    const core = new RecordingCore();
    const control = createOrganizationRuntimeControlHostWithCoreForTest(config(declared), core as OrganizationRuntimeHost, { acceptanceStorePath: root, controlToken: token, storeOptions });
    try {
      await control.start();
      const result = await control.accept(acceptance(judge));
      if (!admitted) { assert.equal((result as { code?: string }).code, "invalid_request"); continue; }
      assert.equal(result.state, "accepted");
      // The stored record re-reads under the same bound, and the turn receives the whole text.
      const deadline = Date.now() + 5_000;
      while (core.wakes.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(core.wakes[0]?.event.text, judge);
      const receipt = await control.wakeReceipt(token, (result as { acceptance_id: string }).acceptance_id);
      assert.ok(receipt);
    } finally { await control.stop(); await rm(root, { recursive: true, force: true }); }
  }
});

test("the engine host parses wake text under the configured bound", async () => {
  const wake = { token: "wrong", agentId: "judge", event: { version: "noopolis.daimon.wake.v1", id: "w", kind: "manual", text: judge, occurredAt: "2026-11-04T00:00:00.000Z" } } as const;
  // Past the parse, an unauthenticated wake is refused as unauthorized; a text over the bound never gets there.
  assert.equal((await createOrganizationRuntimeHost(config()).wake(wake) as { code?: string }).code, "invalid_request");
  assert.equal((await createOrganizationRuntimeHost(config(196_608)).wake(wake) as { code?: string }).code, "unauthorized");
});

test("the declared bound is optional, never lowers the default and is capped", () => {
  assert.equal(parseOrganizationRuntimeConfig(config()).host.maxWakeTextBytes, undefined);
  assert.equal(parseOrganizationRuntimeConfig(config(65_536)).host.maxWakeTextBytes, 65_536);
  for (const invalid of [16_383, 262_145, 1.5]) assert.throws(() => parseOrganizationRuntimeConfig(config(invalid)), /maxWakeTextBytes/);
});
