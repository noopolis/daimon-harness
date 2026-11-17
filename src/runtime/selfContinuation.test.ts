import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { attentionTools, type AttentionRegistry, type AttentionTurn } from "./attention.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { continuationDepth, MAX_SELF_CONTINUATIONS, selfContinuationRequest } from "./selfContinuation.js";

const tokenEnv = "DAIMON_SELF_CONTINUATION_TOKEN";
const token = "self-continuation";
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 400; n++) { if (await check()) return; await pause(); }
  throw new Error("expected side effect did not appear");
}

async function fixture(onTurn: (event: WakeEvent, turn: AttentionTurn, registry: AttentionRegistry) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-self-continuation-")); await chmod(root, 0o700);
  const previous = process.env[tokenEnv]; process.env[tokenEnv] = token;
  const config = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: tokenEnv },
    agents: [{ id: "alpha", name: "Alpha", instructions: "Act", workspacePath: "/workspace/alpha", runtimeHomePath: "/homes/alpha", engine: { kind: "codex" }, attention: {} }] };
  const registry: AttentionRegistry = new Map();
  const calls: WakeEvent[] = [];
  const host = createOrganizationRuntimeHostForTest(config, async () => ({ id: "alpha",
    status: () => ({ agentId: "alpha", state: "idle" }), stop: async () => {},
    wake: async (event) => { calls.push(event); await onTurn(event, registry.get("alpha")!, registry); return { agentId: "alpha", text: "done", durationMs: 1 }; }
  }));
  const control = createOrganizationRuntimeControlHostWithCoreForTest(config, host, { acceptanceStorePath: root, controlToken: token, attentionRegistryForTest: registry,
    storeOptions: process.platform === "linux" ? {} : { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true },
    fuseEnvironment: { DAIMON_WAKE_FUSE: "off" } });
  await control.start();
  return { calls, control, async cleanup() { await control.stop(); await rm(root, { recursive: true, force: true }); if (previous === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previous; } };
}
const message = (id: string, text: string) => ({ token, agent_id: "alpha", delivery_id: id, event: { version: "noopolis.daimon.wake.v2", kind: "message", text, occurred_at: "2026-11-17T10:00:00.000Z" } });
const continueTool = (registry: AttentionRegistry) => attentionTools("alpha", registry).find((tool) => tool.name === "daimon_continue")!;

test("a turn's continuation runs as a separate later turn that carries only its note", async () => {
  const f = await fixture(async (event, turn, registry) => {
    for (const item of turn.messages) await turn.disposition(item.delivery_id, "complete");
    if (turn.messages[0]!.delivery_id === "moltnet:assignment") {
      const result = await continueTool(registry).execute("c", { note: "Verify drafts/a.json against drafts/a.rows, then file it." }, undefined, undefined, {} as never);
      assert.equal((result.details as { link: number }).link, 1);
      await assert.rejects(continueTool(registry).execute("c", { note: "again" }, undefined, undefined, {} as never), /already scheduled/);
    }
  });
  try {
    await f.control.accept(message("moltnet:assignment", "Write the piece."));
    await until(() => f.calls.length === 2);
    await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    assert.equal(f.calls[1]!.kind, "manual");
    assert.notEqual(f.calls[1]!.id, f.calls[0]!.id);
    assert.match(f.calls[1]!.text, /Continuation 1 of at most 3/);
    assert.match(f.calls[1]!.text, /Verify drafts\/a\.json/);
    assert.doesNotMatch(f.calls[1]!.text, /Write the piece/);
    await until(async () => { const agent = (await f.control.availability(token))!.agents[0]!; return agent.pending === 0 && !agent.running; });
  } finally { await f.cleanup(); }
});

test("a chain of continuations stops at its bound", async () => {
  const refusals: string[] = [];
  const f = await fixture(async (_event, turn, registry) => {
    for (const item of turn.messages) await turn.disposition(item.delivery_id, "complete");
    await continueTool(registry).execute("c", { note: "keep going" }, undefined, undefined, {} as never).catch((error: Error) => { refusals.push(error.message); });
  });
  try {
    await f.control.accept(message("moltnet:start", "Begin."));
    await until(() => refusals.length === 1);
    assert.equal(f.calls.length, MAX_SELF_CONTINUATIONS + 1);
    assert.match(refusals[0]!, /Continuation limit reached/);
  } finally { await f.cleanup(); }
});

test("the continuation request validates its note and counts links from the delivery id", () => {
  const base = { token, agentId: "alpha", executionId: "00000000-0000-4000-8000-000000000001", now: new Date("2026-11-17T10:00:00.000Z") };
  assert.throws(() => selfContinuationRequest({ ...base, deliveryIds: ["x"], note: "  " }), /needs a note/);
  assert.throws(() => selfContinuationRequest({ ...base, deliveryIds: ["x"], note: "n".repeat(2001) }), /at most 2000/);
  const next = selfContinuationRequest({ ...base, deliveryIds: ["moltnet:a", "daimon-continue:2:abc"], note: "verify" });
  assert.equal(next.continuation.link, 3);
  assert.equal(continuationDepth(next.request.delivery_id), 3);
  assert.equal(next.request.event.occurred_at, "2026-11-17T10:00:00.000Z");
  assert.equal(continuationDepth("moltnet:daimon-continue:9:x"), 0);
});
