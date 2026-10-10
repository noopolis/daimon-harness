import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";
import { WakeAcceptanceStore } from "./wakeAcceptance.js";
import { wakeAcceptanceIdentity } from "./wakeAcceptanceSchema.js";

for (const explicit of [true, false]) {
  test(`${explicit ? "explicit" : "environment"} context owns persisted delivery identity and replay`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-causal-delivery-"));
    const prior = process.env.NOOPOLIS_RUN_ID;
    const runId = explicit ? "host-run" : "ambient-run";
    process.env.NOOPOLIS_RUN_ID = "ambient-run";
    let prompts = 0;
    const sessionFactory: PiSessionFactory = async () => ({ session: {
      subscribe() { return () => {}; },
      async prompt() { prompts += 1; },
      dispose() {}
    } });
    const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), sessionFactory });
    const input = {
      id: "agent", name: "agent", instructions: "test", tools: [],
      workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "runtime"),
      ...(explicit ? { causalRunId: runId } : {})
    };
    const event: WakeEvent = {
      id: "moltnet:delivery", kind: "message", from: "sender", text: "run_id: forged-body",
      delivery: { eventId: "moltnet:delivery", sender: "sender", target: "agent", contextId: "context" }
    };
    const handles = [];
    try {
      handles.push(await adapter.startAgent(input));
      if (explicit) process.env.NOOPOLIS_RUN_ID = "changed-ambient-run";
      await handles[0].wake(event);
      const store = new WakeAcceptanceStore(input.runtimeHomePath, input.id, undefined, explicit ? runId : undefined);
      const state = await store.loadState();
      assert.equal(state.run_id, runId);
      assert.equal(state.records[0].state, "completed");
      assert.equal(state.records[0].identity, wakeAcceptanceIdentity({ runId, agentId: input.id, eventId: event.id }));
      handles.push(await adapter.startAgent(input));
      await handles[1].wake(event);
      assert.equal(prompts, 1, "a restarted handle must replay the completed delivery without invoking");
      const rows = (await readFile(path.join(input.runtimeHomePath, "telemetry", "causal.jsonl"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(rows.map((row) => row.type), ["turn.input.submitted", "turn.output.completed"]);
      assert.ok(rows.every((row) => row.run_id === runId && row.principal_id === "agent:agent"));
    } finally {
      await Promise.all(handles.map((handle) => handle.stop()));
      if (prior === undefined) delete process.env.NOOPOLIS_RUN_ID;
      else process.env.NOOPOLIS_RUN_ID = prior;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("capabilities and rejection occur before creating runtime state or sessions", async () => {
  assert.deepEqual(PiHarnessAdapter.capabilities, { causalRunId: true, memoryCausalRunId: false });
  assert.ok(Object.isFrozen(PiHarnessAdapter.capabilities));
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-causal-startup-"));
  let started = false;
  const sessionFactory: PiSessionFactory = async () => { started = true; throw new Error("must not start"); };
  const input = { id: "agent", name: "agent", instructions: "test", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "runtime") };
  try {
    const adapter = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), sessionFactory });
    for (const causalRunId of ["", " \n\t"]) await assert.rejects(adapter.startAgent({ ...input, causalRunId }), /non-blank/u);
    const memory = new PiHarnessAdapter({ authPath: path.join(root, "auth.json"), sessionFactory, memory: {} });
    await assert.rejects(memory.startAgent({ ...input, causalRunId: "host-run" }), /memory runtime with explicit causal context/u);
    assert.equal(started, false);
    await assert.rejects(access(input.runtimeHomePath), { code: "ENOENT" });
    await assert.rejects(access(input.workspacePath), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
