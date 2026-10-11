import assert from "node:assert/strict";
import { constants } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { WakeMomentIo } from "./wakeMomentIo.js";
import { openMomentFile, readMomentJson, writeMomentBytes } from "./wakeMomentFs.js";
import { appendWakeMomentRow, pruneWakeMoments, recordWakeMoment, type WakeMomentRow } from "./wakeMomentRecorder.js";
import { captureWakeSnapshot, snapshotName } from "./wakeMomentSnapshot.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-bounds-"));
  const directory = path.join(root, "store"), source = path.join(root, "source");
  await mkdir(directory, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  const recording = { directory, keepMs: 1000, snapshots: [{ id: "state", path: source }] };
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/home/agent", engine: { kind: "codex" }, recording };
  t.after(() => rm(root, { recursive: true, force: true }));
  const rows = path.join(directory, WAKE_MOMENTS.rowsFile), base = path.join(directory, "snapshots", "state");
  return { root, directory, source, agent, recording, rows, base };
}

function row(started_at: string, execution_id: string): WakeMomentRow {
  return { version: WAKE_MOMENTS.version, agent_id: "agent", execution_id, started_at, deliveries: [], snapshots: [] };
}

test("current attempt protects every referenced snapshot even when another base is newer", async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-10T00:00:00.000Z");
  await writeFile(path.join(f.source, "data"), "before");
  const capture = (age: number, executionId: string) => captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt: new Date(now - age).toISOString(), executionId });
  const currentCapture = await capture(5000, "current"), newer = await capture(1000, "newer");
  const current = { ...row(new Date(now - 5000).toISOString(), "current"), snapshots: [currentCapture.snapshot] };
  await appendWakeMomentRow(f.directory, current);
  await pruneWakeMoments({ ...f.recording, keepMs: 1 }, "agent", now, current);
  assert.equal(JSON.parse(await readFile(f.rows, "utf8")).execution_id, "current");
  for (const result of [currentCapture, newer]) {
    assert.ok((await lstat(path.join(f.base, result.snapshot.snapshot))).isDirectory());
    await lstat(path.join(f.base, `${result.snapshot.snapshot}.manifest.json`));
    await lstat(path.join(f.base, `${result.snapshot.snapshot}.complete`));
  }
});

test("writer and reader share the exact serialized manifest boundary before publication", async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-10T00:00:00.000Z"), startedAt = new Date(now).toISOString();
  // Empty source makes the bytes deterministic while still exercising both publication renames.
  const manifest = { version: WAKE_MOMENTS.version, id: "state", snapshot: snapshotName(startedAt, "exact"), started_at: startedAt, sourcePath: f.source, entries: {} };
  const bound = Buffer.byteLength(JSON.stringify(manifest));
  await recordWakeMoment(f.agent, "exact", [], { now: () => now, maxManifestBytes: bound });
  const exact: WakeMomentRow = JSON.parse(await readFile(f.rows, "utf8"));
  assert.equal(exact.error, undefined); assert.equal(exact.snapshots.length, 1);
  const manifestPath = path.join(f.base, `${exact.snapshots[0]!.snapshot}.manifest.json`);
  assert.equal((await lstat(manifestPath)).size, bound);
  assert.deepEqual(await readMomentJson(manifestPath, new WakeMomentIo(), bound), manifest);
  await assert.rejects(readMomentJson(manifestPath, new WakeMomentIo(), bound - 1), /manifest_size_limit/);
  const renames: string[] = [];
  // Equal-length execution ids ensure only the injected byte limit changes.
  await recordWakeMoment(f.agent, "above", [], { now: () => now, maxManifestBytes: bound - 1,
    probe: (operation, target) => { if (operation === "rename") renames.push(target!); } });
  const rows = (await readFile(f.rows, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.match(rows[1].error, /manifest_size_limit/); assert.deepEqual(rows[1].snapshots, []);
  assert.deepEqual(renames, [], "oversized manifests cannot publish even the directory");
  assert.equal((await readdir(f.base)).some((name) => name.includes("above")), false);
});

test("manifest and row reads stay constant as unexpired history grows", async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-10T00:00:00.000Z");
  const startedAt = new Date(now - 100).toISOString();
  await writeFile(path.join(f.source, "data"), "state");
  const first = await captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt, executionId: "seed" });
  await appendWakeMomentRow(f.directory, { ...row(startedAt, "seed"), snapshots: [first.snapshot] });
  const measure = async (executionId: string) => {
    const counts = { manifests: 0, rows: 0 };
    await recordWakeMoment(f.agent, executionId, [], { now: () => now, probe: (operation, target) => {
      if (operation === "read" && target?.endsWith(".manifest.json")) counts.manifests++;
      if (operation === "read" && target === f.rows) counts.rows++;
    } });
    return counts;
  };
  const small = await measure("small");
  // Seed real complete snapshots cheaply; no additional capture or count reset hides a history read.
  const original = path.join(f.base, `${first.snapshot.snapshot}.manifest.json`);
  const value = JSON.parse(await readFile(original, "utf8"));
  for (let i = 0; i < 100; i++) {
    const stamp = new Date(now - 900 + i).toISOString(), name = snapshotName(stamp, `old-${i}`);
    await mkdir(path.join(f.base, name));
    await writeFile(path.join(f.base, `${name}.manifest.json`), JSON.stringify({ ...value, snapshot: name, started_at: stamp }));
    await writeFile(path.join(f.base, `${name}.complete`), "");
    await appendWakeMomentRow(f.directory, { ...row(stamp, `old-${i}`), deliveries: [{ acceptance_id: "x".repeat(2000), delivery_id: "id", kind: "message", occurred_at: stamp }] });
  }
  const large = await measure("large");
  assert.deepEqual(small, { manifests: 2, rows: 2 }); // One manifest read plus its EOF check.
  assert.deepEqual(large, small, "only the link base and bounded ledger head/tail are read");
});

for (const phase of ["capture", "publish", "retention"] as const) test(`store ancestor swap before ${phase} cannot write or delete outside the pinned store`, async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-10T00:00:00.000Z");
  await writeFile(path.join(f.source, "data"), "private state");
  if (phase === "retention") {
    for (let age = 3000; age >= 2000; age -= 1000) await captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt: new Date(now - age).toISOString(), executionId: `old-${age}` });
  }
  const outside = path.join(f.root, "outside");
  await cp(f.directory, outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel"), "untouched");
  const before = (await readdir(outside, { recursive: true })).sort();
  const logs: string[] = []; t.mock.method(console, "error", (message: string) => logs.push(message));
  let swapped = false;
  await recordWakeMoment(f.agent, "swapped", [], { now: () => now, probe: async (operation, target) => {
    const trigger = phase === "capture" ? operation === "mkdir" : phase === "publish" ? operation === "rename" : operation === "unlink";
    if (!swapped && trigger && target?.startsWith(f.directory)) {
      swapped = true;
      await rename(f.directory, path.join(f.root, "pinned"));
      await symlink(outside, f.directory);
    }
  } });
  assert.equal(swapped, true);
  assert.deepEqual((await readdir(outside, { recursive: true })).sort(), before);
  assert.equal(await readFile(path.join(outside, "sentinel"), "utf8"), "untouched");
  assert.ok(logs.some((line) => line.includes("recording_store_changed")));
  assert.ok(logs.every((line) => !line.includes(f.root)));
});

test("never-resolving filesystem operation cannot hold recording past its deadline", { timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  let stalled = false, watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      recordWakeMoment(f.agent, "bounded", [], { captureDeadlineMs: 200, probe: async (operation, target) => {
        if (operation === "mkdir" && target?.endsWith(".partial")) { stalled = true; await new Promise(() => {}); }
      } }),
      new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error("recording exceeded its deadline")), 1000); })
    ]);
  } finally { clearTimeout(watchdog); }
  assert.equal(stalled, true, "the injected filesystem operation must actually be reached");
  const recorded: WakeMomentRow = JSON.parse(await readFile(f.rows, "utf8"));
  assert.match(recorded.error!, /capture_deadline_exceeded/); assert.deepEqual(recorded.snapshots, []);
});

test("manifest chunks issue no further writes after deadline abandonment", async (t) => {
  const f = await fixture(t), target = path.join(f.directory, "manifest.tmp");
  let release!: () => void, writes = 0;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const io = new WakeMomentIo(async (operation) => { if (operation === "write" && ++writes === 2) await pending; });
  let work!: Promise<void>;
  await assert.rejects(io.bounded(150, () => {
    work = (async () => {
      const fd = await openMomentFile(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, io);
      try { await writeMomentBytes(fd, "x".repeat(3 * 64 * 1024)); } finally { await fd.close(); }
    })();
    return work;
  }), /capture_deadline_exceeded/);
  assert.equal(writes, 2);
  release(); await assert.rejects(work, /capture_deadline_exceeded/);
  assert.equal(writes, 2); assert.equal((await lstat(target)).size, 64 * 1024);
});
