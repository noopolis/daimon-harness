import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attentionTools, type AttentionRegistry, taskClockAttentionMessages } from "./attention.js";
import { inboxPrompt } from "./attentionDispatcher.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import type { OrganizationRuntimeHost, OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";

const real = "2026-10-11T12:00:00.000Z", task = "2001-01-01T00:00:00.000Z";
const raw = JSON.stringify({ version: "noopolis.task-clock.v1", origin: task, anchorEpochMs: Date.parse(real) });
const messages = [{ acceptance_id: "receipt", delivery_id: "delivery", kind: "message", occurred_at: real,
  text: JSON.stringify({ created_at: "1999-12-31T23:59:00.000Z", body: "historical Moltnet message" }) }];
const records = messages.map(({ acceptance_id, delivery_id, ...event }) => ({ acceptance_id, delivery_id,
  event: { ...event, version: "noopolis.daimon.wake.v2" as const, kind: "message" as const } }));

test("attention prompt and inbox retain production bytes except the envelope date", async (t) => {
  const previous = process.env; process.env = { ...previous }; delete process.env.NOOPOLIS_TASK_CLOCK;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(real) });
  t.after(() => { process.env = previous; });
  const registry: AttentionRegistry = new Map([["a", { executionId: "execution", messages: taskClockAttentionMessages(records), budget: async () => ({ epoch: "operator-window" }), disposition: async () => {} }]]);
  const read = () => attentionTools("a", registry)[0]!.execute("read", {}, undefined, undefined, {} as never);
  const unclocked = await read();
  const prompts = (["grok", "codex", "agy"] as const).map((engine) => inboxPrompt(taskClockAttentionMessages(records), engine));
  process.env.NOOPOLIS_TASK_CLOCK = raw;
  registry.set("a", { ...registry.get("a")!, messages: taskClockAttentionMessages(records) });
  const clocked = await read();
  assert.equal(JSON.stringify(clocked), JSON.stringify(unclocked).replaceAll(real, task));
  for (const [i, engine] of (["grok", "codex", "agy"] as const).entries()) {
    assert.equal(inboxPrompt(taskClockAttentionMessages(records), engine), prompts[i]!.replaceAll(real, task));
  }
  assert.equal(messages[0]!.occurred_at, real, "stored producer metadata is never mutated");
});

for (const attention of [undefined, {}]) {
  for (const kind of ["message", "schedule"] as const) test(`durable ${attention ? "attention" : "single"} external ${kind} dispatch projects the wake envelope`, { timeout: 5000 }, async (t) => {
    const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: raw };
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(real) + 60_000 });
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-dispatch-clock-"));
    const registry: AttentionRegistry = new Map();
    let inbox: { messages: { occurred_at: string }[] } | undefined;
    let receive!: (value: OrganizationRuntimeWakeRequest) => void;
    const seen = new Promise<OrganizationRuntimeWakeRequest>((resolve) => { receive = resolve; });
    const core: OrganizationRuntimeHost = {
      async start() {}, async stop() { return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" }; },
      async health() { return { version: "noopolis.daimon.organization-runtime-health.v1", state: "running", agents: [] }; },
      async activity() { return { version: "noopolis.daimon.organization-runtime-activity.v1", items: [] }; },
      async wake(request) {
        if (attention) {
          const result = await attentionTools("a", registry)[0]!.execute("read", {}, undefined, undefined, {} as never);
          inbox = result.details as typeof inbox;
        }
        receive(request);
        return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: "a", wakeId: request.event.id, text: "", durationMs: 0 };
      }
    };
    const config = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CLOCK_TEST_TOKEN" },
      agents: [{ id: "a", name: "A", instructions: "test", workspacePath: "/workspace/a", runtimeHomePath: "/home/a", engine: { kind: "codex" }, ...(attention === undefined ? {} : { attention }) }] };
    const control = createOrganizationRuntimeControlHostWithCoreForTest(config, core, { acceptanceStorePath: root, controlToken: "test", attentionRegistryForTest: registry,
      fuseEnvironment: { DAIMON_WAKE_FUSE: "off" },
      storeOptions: { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true } });
    t.after(async () => { await control.stop(); process.env = previous; await rm(root, { recursive: true, force: true }); });
    await control.start();
    await control.accept({ token: "test", agent_id: "a", delivery_id: "delivery", event: { version: "noopolis.daimon.wake.v2", kind, text: messages[0]!.text, occurred_at: real } });
    const wake = await seen;
    assert.equal(wake.event.occurredAt, task);
    if (attention) { assert.equal(inbox!.messages[0]!.occurred_at, task); assert.ok(wake.event.text.includes(task)); assert.ok(!wake.event.text.includes(real)); }
    else assert.equal(wake.event.text, messages[0]!.text);
    assert.ok(wake.event.text.includes("1999-12-31T23:59:00.000Z"));
  });
}
