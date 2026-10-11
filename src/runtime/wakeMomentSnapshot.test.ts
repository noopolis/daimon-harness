import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureWakeSnapshot, readSnapshotManifest, snapshotRootName } from "./wakeMomentSnapshot.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-snapshot-"));
  const directory = path.join(root, "recording"), source = path.join(root, "source");
  await mkdir(directory, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const capture = (second: number, extra = {}) => captureWakeSnapshot({ directory, root: { id: "state", path: source }, startedAt: `2026-10-09T08:20:${String(second).padStart(2, "0")}.123Z`, executionId: "execution", ...extra });
  const base = path.join(directory, "snapshots", "state");
  return { root, directory, source, capture, base };
}

test("incremental snapshots allocate only changed bytes and hard-link every unchanged file", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.source, "nested"));
  await writeFile(path.join(f.source, "nested", "unchanged"), "x".repeat(128 * 1024));
  await writeFile(path.join(f.source, "also-unchanged"), "y".repeat(64 * 1024));
  await writeFile(path.join(f.source, "changed"), "before");
  const first = await f.capture(1);
  await writeFile(path.join(f.source, "changed"), "after!");
  const second = await f.capture(2);
  assert.deepEqual(second.snapshot, { id: "state", snapshot: second.snapshot.snapshot, files: 3, copied: 1, linked: 2, skipped: 0 });
  let newBytes = 0;
  for (const rel of ["nested/unchanged", "also-unchanged", "changed"]) {
    const a = await lstat(path.join(f.base, first.snapshot.snapshot, rel)), b = await lstat(path.join(f.base, second.snapshot.snapshot, rel));
    if (rel === "changed") { assert.notEqual(a.ino, b.ino); newBytes += b.size; }
    else { assert.equal(a.ino, b.ino); assert.ok(b.nlink > 1); }
    assert.notEqual(b.ino, (await lstat(path.join(f.source, rel))).ino, "never link the live source");
  }
  assert.equal(newBytes, Buffer.byteLength("after!"));
  assert.equal(await readFile(path.join(f.base, first.snapshot.snapshot, "changed"), "utf8"), "before");
  const manifest = await readSnapshotManifest(f.base, second.snapshot.snapshot, "state");
  assert.equal(manifest!.entries["nested"]!.type, "directory");
  assert.equal(typeof manifest!.entries["changed"]!.source.ctimeNs, "string");
});

test("ctime detects same-size content changes after the original mtime is restored", async (t) => {
  const f = await fixture(t), file = path.join(f.source, "file");
  await writeFile(file, "before");
  const stamp = new Date("2026-01-01T00:00:00.000Z");
  await utimes(file, stamp, stamp); // exact, representable mtime before BOTH captures
  const first = await f.capture(1);
  const before = await lstat(file, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(file, "after!"); await utimes(file, stamp, stamp);
  const after = await lstat(file, { bigint: true });
  assert.equal(before.ino, after.ino); assert.equal(before.size, after.size);
  assert.equal(before.mtimeNs, after.mtimeNs); assert.notEqual(before.ctimeNs, after.ctimeNs);
  const second = await f.capture(2);
  assert.equal(second.snapshot.copied, 1); assert.equal(second.snapshot.linked, 0);
  const a = path.join(f.base, first.snapshot.snapshot, "file"), b = path.join(f.base, second.snapshot.snapshot, "file");
  assert.notEqual((await lstat(a)).ino, (await lstat(b)).ino);
  assert.equal(await readFile(b, "utf8"), "after!");
});

test("external symlinks are recreated without reading their inaccessible targets", async (t) => {
  const f = await fixture(t), outside = path.join(f.root, "outside");
  await mkdir(outside); await writeFile(path.join(outside, "secret"), "must never be copied");
  await symlink(outside, path.join(f.source, "link"));
  await chmod(outside, 0);
  try {
    const { snapshot } = await f.capture(1);
    assert.equal(snapshot.files, 0);
    const link = path.join(f.base, snapshot.snapshot, "link");
    assert.ok((await lstat(link)).isSymbolicLink()); assert.equal(await readlink(link), outside);
    assert.deepEqual(await readdir(path.join(f.base, snapshot.snapshot)), ["link"]);
    assert.equal((await readSnapshotManifest(f.base, snapshot.snapshot, "state"))!.entries.link!.target, outside);
  } finally { await chmod(outside, 0o700); }
});

test("missing roots complete empty snapshots; entry-limit failures remove partials", async (t) => {
  const f = await fixture(t);
  await rm(f.source, { recursive: true });
  const missing = await f.capture(1);
  assert.equal(missing.note, "root_missing"); assert.equal(missing.snapshot.files, 0);
  await mkdir(f.source); await mkdir(path.join(f.source, "directory"));
  await writeFile(path.join(f.source, "a"), "a"); await writeFile(path.join(f.source, "b"), "b");
  await assert.rejects(f.capture(2, { maxEntries: 2 }), /snapshot_entry_limit/);
  assert.deepEqual((await readdir(f.base)).sort(), [missing.snapshot.snapshot, `${missing.snapshot.snapshot}.manifest.json`].sort());
});

test("replays never overwrite and filesystem-unsafe identifiers cannot escape the store", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "file"), "before");
  const first = await f.capture(1);
  await writeFile(path.join(f.source, "file"), "after!");
  const second = await f.capture(1);
  assert.notEqual(first.snapshot.snapshot, second.snapshot.snapshot);
  assert.equal(await readFile(path.join(f.base, first.snapshot.snapshot, "file"), "utf8"), "before");
  for (const id of [".", ".."]) {
    const result = await f.capture(3, { root: { id, path: f.source }, executionId: "../../unsafe/id" });
    assert.match(result.snapshot.snapshot, /^20261009T082003123Z-sha256-[a-f0-9]{64}$/);
    assert.equal(await readFile(path.join(f.directory, "snapshots", snapshotRootName(id), result.snapshot.snapshot, "file"), "utf8"), "after!");
  }
});


test("special filesystem entries are skipped and counted without opening them", async (t) => {
  const f = await fixture(t);
  await promisify(execFile)("mkfifo", [path.join(f.source, "pipe")]);
  const { snapshot } = await f.capture(1);
  assert.equal(snapshot.skipped, 1); assert.equal(snapshot.files, 0);
  assert.deepEqual(await readdir(path.join(f.base, snapshot.snapshot)), []);
});
