import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { latestSnapshotIndex } from "./wakeMomentHistory.js";
import { WakeMomentIo, type WakeMomentIoProbe } from "./wakeMomentIo.js";
import { pruneWakeMoments, recordWakeMoment, type WakeMomentRow } from "./wakeMomentRecorder.js";
import { captureWakeSnapshot, snapshotName } from "./wakeMomentSnapshot.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const now = Date.parse("2026-10-10T00:00:00.000Z");
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-history-"));
  const directory = path.join(root, "store"), source = path.join(root, "source"), base = path.join(directory, "snapshots", "state");
  await mkdir(directory, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  await writeFile(path.join(source, "data"), "original");
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = { directory, keepMs: 1000, snapshots: [{ id: "state", path: source }] };
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/home/agent", engine: { kind: "codex" }, recording };
  const capture = (time: number, executionId: string) => captureWakeSnapshot({ directory, root: recording.snapshots[0]!, startedAt: new Date(time).toISOString(), executionId });
  const rows = async (): Promise<WakeMomentRow[]> => (await readFile(path.join(directory, WAKE_MOMENTS.rowsFile), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { root, directory, source, base, recording, agent, capture, rows };
}

for (const marker of ["nonzero", "hard-linked"]) for (const pointer of ["missing", "ineligible"]) test(`${marker} newer marker with ${pointer} pointer never displaces the valid newest snapshot`, async (t) => {
  const f = await fixture(t), valid = (await f.capture(now - 4000, "valid")).snapshot.snapshot;
  const stamp = new Date(now - 2000).toISOString(), foreign = snapshotName(stamp, "foreign"), target = path.join(f.base, foreign);
  await mkdir(target); await writeFile(path.join(target, "data"), "poisoned");
  const manifest = JSON.parse(await readFile(path.join(f.base, `${valid}.manifest.json`), "utf8"));
  await writeFile(`${target}.manifest.json`, JSON.stringify({ ...manifest, snapshot: foreign, started_at: stamp }));
  await writeFile(`${target}.complete`, marker === "nonzero" ? "foreign marker" : "");
  if (marker === "hard-linked") await link(`${target}.complete`, path.join(f.root, "foreign-link"));
  if (pointer === "missing") await rm(path.join(f.base, "latest"));
  else {
    const index = JSON.parse(await readFile(path.join(f.base, "latest"), "utf8"));
    await writeFile(path.join(f.base, "latest"), JSON.stringify({ ...index, snapshot: foreign, oldest: valid }));
  }
  // No current-attempt protection: this is also the failed/removed-root case from the review.
  await pruneWakeMoments({ ...f.recording, snapshots: [] }, "agent", now);
  assert.equal(await readFile(path.join(f.base, valid, "data"), "utf8"), "original");
  assert.equal(await readFile(path.join(target, "data"), "utf8"), "poisoned");
  assert.equal(await readFile(`${target}.complete`, "utf8"), marker === "nonzero" ? "foreign marker" : "");
  assert.equal((await lstat(`${target}.complete`)).nlink, marker === "hard-linked" ? 2 : 1);
  // Force base selection through enumeration too, so a poisoned manifest cannot supply links.
  await rm(path.join(f.base, "latest"));
  const captured = await f.capture(now, "after");
  assert.equal(captured.snapshot.linked, 1);
  const output = path.join(f.base, captured.snapshot.snapshot, "data");
  assert.equal(await readFile(output, "utf8"), "original");
  assert.equal((await lstat(output)).ino, (await lstat(path.join(f.base, valid, "data"))).ino);
});

for (const damage of ["missing", "malformed", "dangling", "oversized"]) test(`${damage} latest pointer falls back to enumeration and is repaired`, async (t) => {
  const f = await fixture(t);
  await f.capture(now - 500, "seed");
  const target = path.join(f.base, "latest");
  if (damage === "missing") await rm(target);
  else if (damage === "malformed") await writeFile(target, "{");
  else if (damage === "oversized") await writeFile(target, "x".repeat(1025));
  else {
    const index = JSON.parse(await readFile(target, "utf8"));
    await writeFile(target, JSON.stringify({ ...index, snapshot: snapshotName(new Date(now).toISOString(), "absent") }));
  }
  let entries = 0;
  await recordWakeMoment(f.agent, "repair", [], { now: () => now, probe: (operation, directory, count) => {
    if (operation === "directoryEntries" && directory === f.base) entries += count!;
  } });
  assert.ok(entries >= 3);
  const [row] = await f.rows(); assert.equal(row!.error, undefined); assert.equal(row!.snapshots[0]!.linked, 1);
  const index = JSON.parse(await readFile(target, "utf8"));
  assert.equal(index.snapshot, row!.snapshots[0]!.snapshot);
});

test("latest pointer is bounded, durable before completion, and usable by a fresh reader without history enumeration", async (t) => {
  const f = await fixture(t), events: { operation: string; target: string }[] = [];
  await recordWakeMoment(f.agent, "durable", [], { now: () => now, probe: (operation, target) => {
    if (target) events.push({ operation, target });
  } });
  const [row] = await f.rows(); assert.equal(row!.error, undefined);
  const target = path.join(f.base, "latest"), stat = await lstat(target);
  assert.ok(stat.isFile()); assert.equal(stat.nlink, 1); assert.ok(stat.size <= 1024);
  const rename = events.findIndex((event) => event.operation === "rename" && event.target.startsWith(`${target}.`));
  assert.ok(rename > 0);
  assert.ok(events.slice(0, rename).some((event) => event.operation === "sync" && event.target === events[rename]!.target));
  const synced = events.findIndex((event, i) => i > rename && event.operation === "sync" && event.target === f.base);
  const marker = events.findIndex((event) => event.operation === "open" && event.target.endsWith(".complete"));
  assert.ok(synced > rename && marker > synced);
  let entries = 0;
  const { index, names } = await latestSnapshotIndex(f.base, new WakeMomentIo((operation, _target, count) => {
    if (operation === "directoryEntries") entries += count!;
  }));
  assert.equal(names, undefined); assert.equal(entries, 0); assert.equal(index!.snapshot, row!.snapshots[0]!.snapshot);
});

test("retention enumerates only when a non-newest retained snapshot can expire", async (t) => {
  const f = await fixture(t), old = (await f.capture(now, "old")).snapshot.snapshot;
  const newest = (await f.capture(now + 500, "newest")).snapshot.snapshot;
  const counts: number[] = [];
  for (const time of [now + 900, now + 1001, now + 5000]) {
    let entries = 0;
    const probe: WakeMomentIoProbe = (operation, target, count) => { if (operation === "directoryEntries" && target === f.base) entries += count!; };
    await pruneWakeMoments(f.recording, "agent", time, undefined, new WakeMomentIo(probe)); counts.push(entries);
  }
  assert.equal(counts[0], 0); assert.ok(counts[1]! >= 7); assert.equal(counts[2], 0);
  await assert.rejects(lstat(path.join(f.base, old)), /ENOENT/); await lstat(path.join(f.base, newest));
  assert.equal(JSON.parse(await readFile(path.join(f.base, "latest"), "utf8")).oldest, null);
});

test("clock rollback keeps the newest base while scheduling the older capture for retention", async (t) => {
  const f = await fixture(t), newest = (await f.capture(now + 500, "newest")).snapshot.snapshot;
  const older = (await f.capture(now, "rollback")).snapshot.snapshot;
  const index = JSON.parse(await readFile(path.join(f.base, "latest"), "utf8"));
  assert.equal(index.snapshot, newest); assert.equal(index.oldest, older);
  await pruneWakeMoments(f.recording, "agent", now + 5000);
  await lstat(path.join(f.base, newest)); await assert.rejects(lstat(path.join(f.base, older)), /ENOENT/);
});

test("failed completion after index publication recovers the previous complete base", async (t) => {
  const f = await fixture(t), prior = (await f.capture(now - 500, "prior")).snapshot.snapshot;
  let interrupted = false, recoveredBase: string | undefined, enumerated = false;
  await recordWakeMoment(f.agent, "interrupted", [], { now: () => now, probe: async (operation, target) => {
    if (operation === "open" && target?.endsWith("interrupted.complete")) {
      interrupted = true;
      const recovered = await latestSnapshotIndex(f.base, new WakeMomentIo());
      recoveredBase = recovered.index?.snapshot; enumerated = recovered.names !== undefined;
      throw new Error("injected");
    }
  } });
  assert.equal(interrupted, true); assert.equal(enumerated, true); assert.equal(recoveredBase, prior);
  const { index } = await latestSnapshotIndex(f.base, new WakeMomentIo());
  assert.equal(index!.snapshot, prior);
  await recordWakeMoment(f.agent, "recovered", [], { now: () => now });
  const rows = await f.rows(); assert.deepEqual(rows[0]!.snapshots, []); assert.equal(rows[1]!.error, undefined);
  assert.equal(rows[1]!.snapshots[0]!.linked, 1);
});
