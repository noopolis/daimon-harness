import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { recordWakeMoment, type WakeMomentRow } from "./wakeMomentRecorder.js";
import { captureWakeSnapshot, snapshotName } from "./wakeMomentSnapshot.js";

const now = Date.parse("2026-10-10T00:00:00.000Z"), startedAt = new Date(now).toISOString();
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-safety-"));
  const directory = path.join(root, "store"), source = path.join(root, "source");
  const base = path.join(directory, "snapshots", "state");
  await mkdir(base, { recursive: true, mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = { directory, keepMs: 1000, snapshots: [{ id: "state", path: source }] };
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/home/agent", engine: { kind: "codex" }, recording };
  const rows = async (): Promise<WakeMomentRow[]> => (await readFile(path.join(directory, WAKE_MOMENTS.rowsFile), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { root, directory, source, base, agent, recording, rows };
}

for (const suffix of ["", ".partial", ".manifest.json", ".complete"]) test(`pre-existing ${suffix || "snapshot"} directory and children survive name selection`, async (t) => {
  const f = await fixture(t), name = snapshotName(startedAt, "collision"), foreign = path.join(f.base, `${name}${suffix}`);
  await mkdir(foreign); await writeFile(path.join(foreign, "child"), "foreign");
  const before = await lstat(foreign);
  const result = await captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt, executionId: "collision" });
  assert.notEqual(result.snapshot.snapshot, name);
  assert.equal((await lstat(foreign)).ino, before.ino);
  assert.deepEqual(await readdir(foreign), ["child"]);
  assert.equal(await readFile(path.join(foreign, "child"), "utf8"), "foreign");
});

for (const kind of ["partial", "destination", "manifest", "marker", "manifest-temp", "latest-temp"] as const) test(`exclusive ${kind} collision never grants cleanup ownership`, async (t) => {
  const f = await fixture(t), name = snapshotName(startedAt, "collision");
  let foreign: string | undefined, inode: number | undefined;
  await recordWakeMoment(f.agent, "collision", [], { now: () => now, probe: async (operation, target) => {
    if (foreign || !target?.startsWith(f.base)) return;
    const matches = kind === "partial" ? operation === "mkdir" && target.endsWith(".partial")
      : kind === "destination" ? operation === "mkdir" && target === path.join(f.base, name)
      : operation === "open" && (kind === "manifest" ? target.endsWith(".manifest.json")
        : kind === "marker" ? target.endsWith(".complete")
        : kind === "manifest-temp" ? target.includes(".manifest.json.") && target.endsWith(".tmp")
        : path.basename(target).startsWith("latest.") && target.endsWith(".tmp"));
    if (!matches) return;
    foreign = target;
    await mkdir(foreign); await writeFile(path.join(foreign, "child"), "foreign");
    inode = (await lstat(foreign)).ino;
  } });
  assert.ok(foreign, "the exclusive-create race was exercised");
  assert.equal((await lstat(foreign)).ino, inode);
  assert.equal(await readFile(path.join(foreign, "child"), "utf8"), "foreign");
  const [row] = await f.rows();
  assert.deepEqual(row!.snapshots, []); assert.match(row!.error!, /EEXIST/);
});

test("pre-existing temporary name is skipped without touching its children", async (t) => {
  const f = await fixture(t);
  let foreign: string | undefined;
  await recordWakeMoment(f.agent, "temp", [], { now: () => now, probe: async (operation, target) => {
    if (!foreign && operation === "lstat" && target?.endsWith(".tmp")) {
      foreign = target;
      await mkdir(foreign); await writeFile(path.join(foreign, "child"), "foreign");
    }
  } });
  assert.ok(foreign);
  assert.equal(await readFile(path.join(foreign, "child"), "utf8"), "foreign");
  const [row] = await f.rows();
  assert.equal(row!.error, undefined); assert.equal(row!.snapshots.length, 1);
});

// Real on-disk races, with no platform override: macOS pathname traversal locally,
// Linux descriptor-relative traversal in the existing Ubuntu CI job.
for (const phase of ["opendir", "readdir", "empty-readdir", "file-open"] as const) test(`source directory swap at ${phase} is rejected before outside content is read`, async (t) => {
  const f = await fixture(t), nested = path.join(f.source, "nested"), outside = path.join(f.root, "outside");
  await mkdir(nested); await mkdir(outside);
  if (phase !== "empty-readdir") await writeFile(path.join(nested, "data"), "inside");
  await writeFile(path.join(outside, "data"), "outside secret");
  let swapped = false, outsideReads = 0;
  await recordWakeMoment(f.agent, "swap", [], { now: () => now, probe: async (operation, target) => {
    if (!target) return;
    if (operation === "read") {
      const actual = await realpath(target).catch(() => "");
      if (actual.startsWith(`${outside}/`)) outsideReads++;
    }
    const trigger = phase === "file-open" ? operation === "open" : operation === (phase === "empty-readdir" ? "readdir" : phase);
    if (!swapped && trigger) {
      const actual = await realpath(target).catch(() => "");
      if (actual !== (phase === "file-open" ? path.join(nested, "data") : nested)) return;
      swapped = true;
      await rename(nested, path.join(f.source, "saved")); await symlink(outside, nested);
    }
  } });
  assert.equal(swapped, true); assert.equal(outsideReads, 0);
  const [row] = await f.rows();
  assert.deepEqual(row!.snapshots, []); assert.match(row!.error!, /source_changed/);
  assert.deepEqual(await readdir(f.base), [], "no complete snapshot or partial outside copy survives");
});

test("directory identity is compared with lstat before opening even for the source root", async (t) => {
  const f = await fixture(t), replacement = path.join(f.root, "replacement");
  await mkdir(replacement); await writeFile(path.join(replacement, "data"), "foreign");
  let swapped = false, reads = 0;
  await recordWakeMoment(f.agent, "root-swap", [], { now: () => now, probe: async (operation, target) => {
    if (operation === "read" && target?.startsWith(f.source)) reads++;
    if (!swapped && operation === "open" && target === f.source) {
      swapped = true;
      await rename(f.source, path.join(f.root, "saved")); await rename(replacement, f.source);
    }
  } });
  assert.equal(swapped, true); assert.equal(reads, 0);
  const [row] = await f.rows();
  assert.deepEqual(row!.snapshots, []); assert.match(row!.error!, /source_changed/);
});
