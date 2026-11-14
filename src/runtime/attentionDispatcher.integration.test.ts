import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { WakeEvent } from "../core/types.js";
import { attentionTools, type AttentionRegistry, type AttentionTurn } from "./attention.js";
import { createOrganizationRuntimeHostForTest } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHostWithCoreForTest } from "./organizationRuntimeControl.js";
import { parseOrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { wakeAcceptanceDigest } from "./wakeAcceptanceTypes.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";

const tokenEnv = "DAIMON_ATTENTION_INTEGRATION_TOKEN";
const token = "attention-integration";
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let n = 0; n < 300; n++) { if (await check()) return; await pause(); }
  throw new Error("expected side effect did not appear");
}
const request = (id: string, text: string, kind = "message") => ({ token, agent_id: "alpha", delivery_id: id,
  event: { version: "noopolis.daimon.wake.v2", kind, text, occurred_at: "2026-09-12T11:30:00.000Z" } });

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-attention-validation-")); await chmod(root, 0o700);
  const previousToken = process.env[tokenEnv]; process.env[tokenEnv] = token;
  const config = { version: "noopolis.daimon.organization-runtime.v1", host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: tokenEnv },
    agents: [{ id: "alpha", name: "Alpha", instructions: "Act", workspacePath: "/workspace/alpha", runtimeHomePath: "/homes/alpha", engine: { kind: "codex" }, attention: {} }] };
  let registry: AttentionRegistry;
  const calls: WakeEvent[] = [];
  let attempts = 0;
  let reject = false;
  let onTurn = async (_event: WakeEvent, turn: AttentionTurn) => {
    for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
  };
  const make = () => {
    registry = new Map();
    // Keep the real host, request parser, store, dispatcher, and inbox tools.
    // Only cognition is substituted; no provider login or network is involved.
    const host = createOrganizationRuntimeHostForTest(config, async () => ({ id: "alpha",
      status: () => ({ agentId: "alpha", state: "idle" }), stop: async () => {},
      wake: async (event) => { calls.push(event); await onTurn(event, registry.get("alpha")!); return { agentId: "alpha", text: "done", durationMs: 1 }; }
    }));
    const wake = host.wake;
    host.wake = async (input) => {
      attempts++;
      if (reject) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "alpha", wakeId: input.event.id, code: "invalid_request" };
      return wake(input);
    };
    return createOrganizationRuntimeControlHostWithCoreForTest(config, host, { acceptanceStorePath: root, controlToken: token, attentionRegistryForTest: registry, storeOptions: process.platform === "linux" ? {} : { processIdentity: async () => ({ pid: 1, process_start: "test-start", boot_id: "test-boot", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true }, fuseEnvironment: { DAIMON_WAKE_FUSE: "off" } });
  };
  let control = make(); await control.start();
  return { root, calls, get attempts() { return attempts; }, get control() { return control; }, get registry() { return registry; },
    set onTurn(value: typeof onTurn) { onTurn = value; }, set reject(value: boolean) { reject = value; },
    async restart() { await control.stop(); control = make(); await control.start(); },
    async cleanup() { await control.stop(); await rm(root, { recursive: true, force: true }); if (previousToken === undefined) delete process.env[tokenEnv]; else process.env[tokenEnv] = previousToken; }
  };
}

test("a valid long scheduled delivery crosses the real host boundary and completes via its intact inbox", async () => {
  const f = await fixture();
  const text = "S".repeat(3540), deliveryId = `schedule:${"a".repeat(180)}:2026-09-12T13:30@GMT+02:00`;
  try {
    parseOrganizationRuntimeWakeRequest({ token, agentId: "alpha", event: { version: "noopolis.daimon.wake.v1", id: "valid-source", kind: "schedule", text, occurredAt: "2026-09-12T11:30:00.000Z" } });
    f.onTurn = async (event, turn) => {
      assert.match(event.text, /read it with daimon_inbox/);
      const tool = attentionTools("alpha", f.registry)[0]!;
      const result = await tool.execute("read", {}, undefined, undefined, {} as never);
      const details = result.details as { messages: Array<{ delivery_id: string; text: string }> };
      assert.equal(details.messages[0]!.text, text); assert.equal(details.messages[0]!.delivery_id, deliveryId);
      await turn.disposition(deliveryId, "complete");
    };
    const receipt = await f.control.accept(request(deliveryId, text, "schedule")); assert.equal(receipt.state, "accepted");
    await until(async () => (await f.control.activityV2(token))!.items[0]?.state === "completed");
    assert.equal(f.calls.length, 1);
    assert.equal((await f.control.availability(token))!.state, "running");
  } finally { await f.cleanup(); }
});

test("a busy inbox batches six large messages without losing payloads or failing the real validator", async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const bodies = Array.from({ length: 6 }, (_, i) => `${i}:` + "R".repeat(1500));
  try {
    f.onTurn = async (event, turn) => {
      if (turn.messages[0]!.delivery_id === "hold") await held;
      else {
        assert.equal(turn.messages.length, 6); assert.match(event.text, /read it with daimon_inbox/);
        assert.deepEqual(turn.messages.map((message) => message.text), bodies);
      }
      for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
    };
    await f.control.accept(request("hold", "wait")); await until(() => f.calls.length === 1);
    for (const [i, body] of bodies.entries()) await f.control.accept(request(`batch-${i}`, body));
    release();
    await until(async () => (await f.control.activityV2(token))!.items.filter((item) => item.state === "completed").length === 7);
    assert.equal(f.calls.length, 2);
  } finally { release(); await f.cleanup(); }
});

test("Unicode is counted in codepoints and a small or multibyte delivery stays inline", async () => {
  const f = await fixture();
  try {
    for (const text of ["small", "😀".repeat(1900)]) {
      f.onTurn = async (event, turn) => {
        assert.ok(event.text.includes(text)); assert.doesNotMatch(event.text, /selected payload exceeds/);
        await turn.disposition(turn.messages[0]!.delivery_id, "complete");
      };
      await f.control.accept(request(`inline-${f.calls.length}`, text));
      await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    }
    assert.equal(f.calls.length, 2);
  } finally { await f.cleanup(); }
});

for (const failure of ["rejected", "engine_failed"] as const) test(`${failure} remains visible after idle and restart, survives unrelated success, and clears on recovery`, async () => {
  const f = await fixture(); let fail = true;
  try {
    f.reject = failure === "rejected";
    f.onTurn = async (_event, turn) => {
      if (fail && turn.messages.some((message) => message.delivery_id === "broken")) throw new Error("provider unavailable Bearer secret-review-token");
      for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
    };
    await f.control.accept(request("broken", "handle the delivery"));
    // A failed execution is retried once, at once, under a fresh execution id;
    // a rejected one never ran and is not.
    if (failure === "engine_failed") await until(() => f.attempts === 2);
    await until(async () => (await f.control.availability(token))!.state === "paused");
    await until(async () => (await f.control.activityV2(token))!.executions!.length === 0);
    if (failure === "engine_failed") assert.notEqual(f.calls[0]!.id, f.calls[1]!.id, "the retry is a new turn, never a replay of the sealed failure");
    const availability = (await f.control.availability(token))!;
    assert.match(availability.agents[0]!.error!, failure === "rejected" ? /invalid_request/ : /provider unavailable/);
    assert.doesNotMatch(JSON.stringify(availability), /secret-review-token/);
    const original = (await f.control.activityV2(token))!.items[0]!;
    assert.equal(original.state, "accepted"); assert.equal(original.deferred, true);
    // A rejected wake never reached cognition and keeps its id; a failed one is cleared so no retry can replay it.
    if (failure === "rejected") assert.ok(original.execution_id); else assert.equal(original.execution_id, undefined);
    const attempts = f.attempts; await pause(40); assert.equal(f.attempts, attempts);
    await f.restart(); await pause(40); assert.equal(f.attempts, attempts);
    assert.equal((await f.control.availability(token))!.state, "paused");
    // Let a different delivery complete while the failed delivery still fails.
    f.reject = false;
    await f.control.accept(request("unrelated", "other work"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.delivery_id === "unrelated" && item.state === "completed"));
    assert.equal((await f.control.availability(token))!.state, "paused");
    // It ran again with the unrelated delivery and failed again: deferred, its dead execution id cleared.
    assert.equal((await f.control.activityV2(token))!.items.find((item) => item.delivery_id === "broken")!.execution_id, undefined);
    // Durable diagnostics are redacted at rest, not only at the HTTP surface.
    for (const file of await readdir(f.root)) if (file.endsWith(".json")) assert.doesNotMatch(await readFile(path.join(f.root, file), "utf8"), /secret-review-token/);
    fail = false; await f.control.accept(request("retry", "new input"));
    await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    assert.equal((await f.control.availability(token))!.state, "running");
    assert.equal((await f.control.availability(token))!.agents[0]!.error, undefined);
  } finally { await f.cleanup(); }
});

test("an agent can explicitly defer recovered work without leaving a runtime failure alarm", async () => {
  const f = await fixture();
  try {
    f.reject = true;
    await f.control.accept(request("defer-later", "work"));
    await until(async () => (await f.control.availability(token))!.state === "paused");
    f.reject = false;
    f.onTurn = async (_event, turn) => {
      for (const message of turn.messages) await turn.disposition(message.delivery_id, message.delivery_id === "defer-later" ? "defer" : "complete");
    };
    await f.control.accept(request("fresh", "new input"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.delivery_id === "fresh" && item.state === "completed"));
    const availability = (await f.control.availability(token))!;
    assert.equal(availability.state, "running"); assert.equal(availability.agents[0]!.error, undefined);
    const receipt = (await f.control.activityV2(token))!.items.find((item) => item.delivery_id === "defer-later")!;
    assert.equal(receipt.state, "accepted"); assert.equal(receipt.deferred, true); assert.equal(receipt.execution_id, undefined);
    await f.restart();
    assert.equal((await f.control.availability(token))!.state, "running");
  } finally { await f.cleanup(); }
});


test("availability stays answerable when durable work belongs to an old agent identity", async () => {
  const f = await fixture();
  try {
    f.reject = true; await f.control.accept(request("old", "work"));
    await until(async () => (await f.control.availability(token))!.state === "paused");
    await until(async () => (await f.control.activityV2(token))!.executions!.length === 0);
    const file = (await readdir(f.root)).find((name) => /^[0-9a-f]{64}\.json$/.test(name))!;
    const record = JSON.parse(await readFile(path.join(f.root, file), "utf8"));
    record.agent_id = "retired";
    record.request_digest = wakeAcceptanceDigest({ token: undefined, agent_id: record.agent_id, delivery_id: record.delivery_id, event: record.event });
    await writeFile(path.join(f.root, file), JSON.stringify(record), { mode: 0o600 });
    const status = await f.control.availability(token);
    assert.ok(status); assert.equal(status.agents[0]!.pending, 0);
  } finally { await f.cleanup(); }
});

test("work a failed turn left undone is retried once at once and completes, with no new input needed", async () => {
  const f = await fixture(); let failures = 1; const logged: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
  try {
    f.onTurn = async (_event, turn) => {
      if (failures-- > 0) throw new Error("engine broker turn failed (limit_exceeded; limit=tokens) Bearer secret-review-token");
      for (const message of turn.messages) await turn.disposition(message.delivery_id, "complete");
    };
    await f.control.accept(request("revision", "file the validated revision"));
    // Mutation guard: deferring the failed delivery (the old behaviour) leaves it waiting for mail that never comes.
    await until(async () => (await f.control.activityV2(token))!.items.every((item) => item.state === "completed"));
    assert.equal(f.attempts, 2);
    assert.equal((await f.control.availability(token))!.agents[0]!.error, undefined);
    assert.ok(logged.some((line) => line.includes("daimon: wake requeued once agent=alpha delivery=revision")), logged.join("\n"));
    assert.equal(logged.filter((line) => line.includes("daimon: wake execution failed agent=alpha") && line.includes("deliveries=revision: engine_failed: engine broker turn failed (limit_exceeded; limit=tokens)")).length, 1, logged.join("\n"));
    // Mutation guard: logging the raw execution error writes the credential to stderr.
    assert.ok(logged.every((line) => !line.includes("secret-review-token")));
  } finally { console.error = original; await f.cleanup(); }
});

test("every failed execution says why on the runtime log, the failed retry included", async () => {
  const f = await fixture(); let attempt = 0; const logged: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
  try {
    f.onTurn = async () => { throw new Error(`CLI engine exited 1: cause ${++attempt} Bearer secret-review-token`); };
    await f.control.accept(request("twice", "work that fails twice"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.deferred === true));
    const failures = logged.filter((line) => line.includes("daimon: wake execution failed agent=alpha"));
    // Mutation guard: only the first failure was logged (as the requeue); the retry's cause existed nowhere but the record.
    assert.equal(failures.length, 2, logged.join("\n"));
    assert.ok(failures[0]!.includes("engine_failed: CLI engine exited 1: cause 1") && failures[1]!.includes("engine_failed: CLI engine exited 1: cause 2"));
    assert.ok(logged.every((line) => !line.includes("secret-review-token")));
  } finally { console.error = original; await f.cleanup(); }
});

test("a delivery unhandled past a day is stopped where the dispatcher meets it, and the expiry is logged", async () => {
  const f = await fixture(); const logged: string[] = []; const original = console.error;
  console.error = (...values: unknown[]) => { logged.push(values.map(String).join(" ")); };
  try {
    f.reject = true; await f.control.accept(request("yesterday", "old work"));
    await until(async () => (await f.control.availability(token))!.state === "paused");
    await until(async () => (await f.control.activityV2(token))!.executions!.length === 0);
    const file = (await readdir(f.root)).find((name) => /^[0-9a-f]{64}\.json$/.test(name))!;
    const record = JSON.parse(await readFile(path.join(f.root, file), "utf8"));
    record.accepted_at = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await writeFile(path.join(f.root, file), JSON.stringify(record), { mode: 0o600 });
    f.reject = false; const before = f.calls.length;
    await f.control.accept(request("today", "new work"));
    await until(async () => (await f.control.activityV2(token))!.items.some((item) => item.delivery_id === "today" && item.state === "completed"));
    const expired = (await f.control.activityV2(token))!.items.find((item) => item.delivery_id === "yesterday")!;
    // Mutation guard: hiding it in `recoverable()` without stopping it leaves it `accepted` and silent.
    assert.deepEqual([expired.state, expired.code], ["stopped", "queued_wake_stopped"]);
    assert.ok(f.calls.slice(before).every((event) => !event.text.includes("old work")), "the expired delivery is never offered again");
    assert.ok(logged.some((line) => /daimon: wake expired agent=alpha delivery=yesterday .* past 24h; stopped queued_wake_stopped/u.test(line)), logged.join("\n"));
  } finally { console.error = original; await f.cleanup(); }
});

test("a delivery stopped between selection and claim is never handed to cognition", async () => {
  const original = WakeAcceptanceStore.prototype.transitionClaimed;
  let raced = false;
  // Another host's expiry lands after this dispatcher selected the delivery: on disk it is
  // already `stopped` when this side moves it to `running`, which the store refuses as terminal.
  WakeAcceptanceStore.prototype.transitionClaimed = async function (this: WakeAcceptanceStore, acceptanceId, claim, state, ...rest) {
    if (state === "running" && !raced) {
      raced = true;
      const root = (this as unknown as { root: string }).root;
      for (const file of await readdir(root)) {
        if (!/^[0-9a-f]{64}\.json$/u.test(file)) continue;
        const record = JSON.parse(await readFile(path.join(root, file), "utf8"));
        if (record.acceptance_id === acceptanceId) await writeFile(path.join(root, file), JSON.stringify({ ...record, state: "stopped", code: "queued_wake_stopped" }), { mode: 0o600 });
      }
    }
    return original.call(this, acceptanceId, claim, state, ...rest);
  };
  const f = await fixture();
  try {
    await f.control.accept(request("expired-elsewhere", "work"));
    await until(() => raced);
    await pause(60);
    // Mutation guard: waking the batch anyway runs cognition on a stopped delivery.
    assert.equal(f.calls.length, 0);
  } finally { WakeAcceptanceStore.prototype.transitionClaimed = original; await f.cleanup(); }
});
