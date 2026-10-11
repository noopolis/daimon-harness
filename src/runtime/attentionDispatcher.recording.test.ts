import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AttentionDispatcher } from "./attentionDispatcher.js";
import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeHost, OrganizationRuntimeWakeRequest } from "./organizationRuntime.js";
import { WakeAcceptanceStore } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";
import type { WakeFuse } from "./wakeFuse.js";
import type { WakeMomentOptions, WakeMomentRow } from "./wakeMomentRecorder.js";

async function fixture(t: test.TestContext, attention: boolean, recording: boolean, recordingOptionsForTest?: WakeMomentOptions, keepMs = 2592000000) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-dispatch-recording-"));
  const directory = path.join(root, "recording"), source = path.join(root, "source"), inbox = path.join(root, "inbox");
  await mkdir(inbox, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  if (recording) await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(source, "data"), "state before the turn");
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/runtime/home", engine: { kind: "codex" },
    ...(attention ? { attention: {} } : {}), ...(recording ? { recording: { directory, keepMs, snapshots: [{ id: "state", path: source }] } } : {}) };
  const store = await WakeAcceptanceStore.open(inbox, { processIdentity: async () => ({ pid: 1, process_start: "test", boot_id: "test", pid_namespace_dev: 1, pid_namespace_ino: 1 }), ownerLiveness: async () => true });
  const requests: OrganizationRuntimeWakeRequest[] = [], failures: unknown[] = [];
  let probe: (request: OrganizationRuntimeWakeRequest) => Promise<void> = async () => {}, admitted = false, allow = true;
  let idle!: () => void;
  const done = new Promise<void>((resolve) => { idle = resolve; });
  const dispatcher = new AttentionDispatcher({ store, agents: [agent], registry: new Map(), token: "token", onIdle: idle, recordingOptionsForTest,
    fuse: { snapshot: async () => ({ state: "available" }), admit: async () => { admitted = allow; return { state: allow ? "admitted" : "blocked" }; } } as unknown as WakeFuse,
    host: { wake: async (request: OrganizationRuntimeWakeRequest) => {
      requests.push(request);
      try { assert.equal(admitted, true); await probe(request); } catch (error) { failures.push(error); }
      return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: agent.id, wakeId: request.event.id, text: "done", durationMs: 1 };
    } } as OrganizationRuntimeHost
  });
  t.after(async () => { await dispatcher.stop(); await store.close(); await rm(root, { recursive: true, force: true }); });
  const records = [];
  for (const delivery_id of attention ? ["first", "second"] : ["first"]) records.push((await store.accept(parseWakeAcceptanceRequest({ token: "token", agent_id: agent.id, delivery_id,
    event: { version: "noopolis.daimon.wake.v2", kind: "message", text: "Handle work", occurred_at: new Date().toISOString() } }))).record);
  return { root, source, directory, dispatcher, requests, records, failures,
    probe: (callback: typeof probe) => { probe = callback; }, block: () => { allow = false; },
    run: async () => { dispatcher.notify(agent.id, true); await done; assert.deepEqual(failures, []); }
  };
}

for (const attention of [false, true]) test(`row and snapshot complete before host.wake (attention=${attention})`, { timeout: 5000 }, async (t) => {
  const f = await fixture(t, attention, true);
  f.probe(async (request) => {
    const row: WakeMomentRow = JSON.parse(await readFile(path.join(f.directory, "wake-moments.jsonl"), "utf8"));
    assert.equal(row.execution_id, request.event.id);
    assert.equal(row.execution_id, f.dispatcher.activeExecutions()[0]!.execution_id);
    if (!attention) assert.equal(row.execution_id, "first"); else assert.notEqual(row.execution_id, "first");
    assert.equal(row.agent_id, "agent"); assert.ok(Date.parse(row.started_at) <= Date.now());
    assert.deepEqual(row.deliveries, f.records.map((r) => ({ acceptance_id: r.acceptance_id, delivery_id: r.delivery_id, kind: r.event.kind, occurred_at: r.event.occurred_at })));
    assert.deepEqual(Object.keys(row).sort(), ["version", "agent_id", "execution_id", "started_at", "deliveries", "snapshots"].sort());
    const snapshot = row.snapshots[0]!;
    const base = path.join(f.directory, "snapshots", "state");
    assert.equal(await readFile(path.join(base, snapshot.snapshot, "data"), "utf8"), "state before the turn");
    assert.equal(JSON.parse(await readFile(path.join(base, `${snapshot.snapshot}.manifest.json`), "utf8")).snapshot, snapshot.snapshot);
    assert.equal((await readdir(base)).some((name) => name.endsWith(".partial")), false);
    await writeFile(path.join(f.source, "data"), "changed by the turn");
  });
  await f.run(); assert.equal(f.requests.length, 1);
});

test("unreadable snapshot root still writes an error row and executes the turn", { timeout: 5000 }, async (t) => {
  if (process.getuid?.() === 0) { t.skip("POSIX permission refusals require an unprivileged uid"); return; }
  const f = await fixture(t, false, true);
  await chmod(f.source, 0);
  f.probe(async () => {
    const row = JSON.parse(await readFile(path.join(f.directory, "wake-moments.jsonl"), "utf8"));
    assert.match(row.error, /EACCES|EPERM/); assert.deepEqual(row.snapshots, []);
  });
  try { await f.run(); assert.equal(f.requests.length, 1); } finally { await chmod(f.source, 0o700); }
});

test("row I/O failure logs a redacted error and still executes exactly once", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, false, true), logs: string[] = [];
  await mkdir(path.join(f.directory, "wake-moments.jsonl"));
  t.mock.method(console, "error", (message: string) => logs.push(message));
  await f.run(); assert.equal(f.requests.length, 1); assert.equal(logs.length, 1);
  assert.match(logs[0]!, /wake recording failed/); assert.ok(!logs[0]!.includes(f.root));
});

test("failed admission causes no recording filesystem activity", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, false, true); f.block();
  await f.run(); assert.equal(f.requests.length, 0); assert.deepEqual(await readdir(f.directory), []);
});

test("without recording the original wake is unchanged and no recording directory is created", { timeout: 5000 }, async (t) => {
  const f = await fixture(t, false, false);
  await f.run(); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], { token: "token", agentId: "agent", event: { version: "noopolis.daimon.wake.v1", id: "first", kind: "message", occurredAt: f.records[0]!.event.occurred_at, text: "Handle work" } });
  await assert.rejects(lstat(f.directory), /ENOENT/);
  assert.deepEqual((await readdir(f.root)).sort(), ["inbox", "source"]);
});

test("current attempt survives keepMs 1 with a clock advancing during capture", { timeout: 5000 }, async (t) => {
  let clock = Date.parse("2026-10-09T12:00:00.000Z");
  const start = clock;
  const f = await fixture(t, false, true, {
    now: () => clock,
    probe: (operation) => { if (operation === "write") clock += 10; }
  }, 1);
  f.probe(async () => {
    assert.ok(clock > start + 1, "capture must actually cross retention's cutoff");
    const row: WakeMomentRow = JSON.parse(await readFile(path.join(f.directory, "wake-moments.jsonl"), "utf8"));
    assert.equal(row.started_at, new Date(start).toISOString());
    assert.equal(row.execution_id, "first"); assert.equal(row.snapshots.length, 1);
    const snapshot = row.snapshots[0]!;
    assert.equal(await readFile(path.join(f.directory, "snapshots", "state", snapshot.snapshot, "data"), "utf8"), "state before the turn");
  });
  await f.run(); assert.equal(f.requests.length, 1);
});

for (const late of [false, true]) test(`capture deadline releases the turn and shutdown; late completion=${late}`, { timeout: 3000 }, async (t) => {
  let release!: () => void, entered!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  let captureWrites = 0, stalledAt = 0, enteredRead = false;
  const deadline = 150;
  const f = await fixture(t, false, true, { captureDeadlineMs: deadline, probe: async (operation, target) => {
    if (operation === "write" && target?.includes(".partial/")) captureWrites++;
    if (operation === "read" && target?.endsWith("/data")) {
      enteredRead = true; stalledAt = performance.now(); entered(); await stalled;
    }
  } });
  f.probe(async () => {
    assert.equal(enteredRead, true);
    const row: WakeMomentRow = JSON.parse(await readFile(path.join(f.directory, "wake-moments.jsonl"), "utf8"));
    assert.match(row.error!, /capture_deadline_exceeded/); assert.deepEqual(row.snapshots, []);
    assert.deepEqual(await readdir(path.join(f.directory, "snapshots", "state")), []);
    assert.ok(performance.now() - stalledAt < 1000, "capture must not hold the turn indefinitely");
  });
  const run = f.run();
  await waiting; await run;
  assert.equal(f.requests.length, 1); assert.equal(captureWrites, 0);
  if (late) { release(); await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.equal(captureWrites, 0, "abandoned capture cannot resume writing alongside cognition");
  await f.dispatcher.stop();
});

test("shutdown during a never-resolving capture settles at its deadline", { timeout: 3000 }, async (t) => {
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, false, true, { captureDeadlineMs: 150, probe: async (operation, target) => {
    if (operation === "read" && target?.endsWith("/data")) { entered(); await new Promise(() => {}); }
  } });
  const run = f.run(); await waiting;
  const start = performance.now(); await f.dispatcher.stop(); await run;
  assert.ok(performance.now() - start < 1000);
});
