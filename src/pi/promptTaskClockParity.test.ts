import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMemoryRuntime } from "@noopolis/mneme";
import type { WakeEvent } from "../core/types.js";
import { PiAgentHandle, type PiSessionLike } from "./piAgentHandle.js";
import { createResourceLoader } from "./prompts.js";

for (const mode of ["ordinary", "memory", "world", "dream"] as const) {
  test(`${mode} wake and system prompts are byte-identical with and without the task clock`, async (t) => {
    const previous = process.env;
    process.env = { ...previous, NOOPOLIS_RUN_ID: "prompt-parity" };
    delete process.env.NOOPOLIS_TASK_CLOCK;
    const root = await mkdtemp(path.join(os.tmpdir(), "daimon-prompt-parity-"));
    // Hold the random dream identity constant: it is an input independent of the clock.
    const random = t.mock.method(crypto, "randomBytes", () => Buffer.from([1, 2, 3, 4]));
    syncBuiltinESMExports();
    t.after(async () => { random.mock.restore(); syncBuiltinESMExports(); process.env = previous; await rm(root, { recursive: true, force: true }); });
    const event: WakeEvent = { id: "daimon:parity", kind: mode === "dream" ? "dream" : "manual", text: "Same input", context: {} };
    if (mode === "world") {
      Object.assign(event, { kind: "message", from: "world", text: JSON.stringify({ version: "simfile.world-nudge.v1", run_id: "parity-world", tick: 4, decision_token: "private-decision" }), delivery: { eventId: event.id, sender: "world", target: "a", contextId: "dm:a:world" } });
    }
    const runtime = createMemoryRuntime({ agentId: "a", runtimeHomePath: path.join(root, "memory") });
    // Fix Mneme's prepared input, so this test checks Daimon's formatting, not an unreleased Mneme behavior.
    const prepared = await runtime.prepareTurn({ eventId: event.id, kind: event.kind, text: event.text, context: {} });
    const memory = { ...runtime, prepareTurn: async () => structuredClone(prepared), recordTurn: async () => {} };
    const prompts: string[] = [], systemPrompts: string[] = [];
    for (const clocked of [false, true]) {
      if (clocked) process.env.NOOPOLIS_TASK_CLOCK = '{"version":"noopolis.task-clock.v1","origin":"2001-01-01T00:00:00Z","anchorEpochMs":0}';
      const session: PiSessionLike = { subscribe: () => () => {}, prompt: async (text) => { prompts.push(text); }, dispose() {} };
      const handle = new PiAgentHandle("a", session, async () => session, path.join(root, String(clocked)), { authMethod: "none", model: "stub", provider: "stub" }, mode === "memory" ? memory : undefined, undefined, {}, mode === "world" ? {} : undefined);
      systemPrompts.push(createResourceLoader({ id: "a", name: "A", instructions: "Same instructions", runtimeHomePath: root, workspacePath: root }, mode === "dream" ? "dream" : "awake", { memory: mode === "memory", world: mode === "world" }).getSystemPrompt()!);
      try { await handle.wake(event); } finally { await handle.stop(); }
    }
    assert.equal(prompts.length, 2);
    if (mode !== "world") assert.ok(prompts[0]!.includes("Same input"));
    if (mode === "dream") assert.match(prompts[0]!, /^## Dream Mode/u);
    if (mode === "world") { assert.match(prompts[0]!, /^World decision wake:/u); assert.doesNotMatch(prompts[0]!, /private-decision/u); }
    assert.equal(prompts[1], prompts[0]);
    assert.equal(systemPrompts[1], systemPrompts[0]);
  });
}
