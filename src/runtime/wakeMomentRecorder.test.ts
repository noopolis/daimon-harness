import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { appendWakeMomentRow, pruneWakeMoments, recordWakeMoment, type WakeMomentRow } from "./wakeMomentRecorder.js";
import { captureWakeSnapshot } from "./wakeMomentSnapshot.js";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), "wake-recorder-"));
  const directory = path.join(root, "store"), source = path.join(root, "source");
  await mkdir(directory, { mode: 0o700 }); await mkdir(source, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  const recording = { directory, keepMs: 1000, snapshots: [{ id: "state", path: source }] };
  const agent: OrganizationRuntimeAgentConfig = { id: "agent", name: "Agent", instructions: "Work", workspacePath: "/workspace", runtimeHomePath: "/home/agent", engine: { kind: "codex" }, recording };
  const rows = path.join(directory, WAKE_MOMENTS.rowsFile);
  return { root, directory, source, agent, recording, rows };
}
const row = (started_at: string, execution_id = "execution"): WakeMomentRow => ({ version: WAKE_MOMENTS.version, agent_id: "agent", execution_id, started_at, deliveries: [], snapshots: [] });

test("retention prunes expired rows and snapshots but preserves newest bases and foreign files", async (t) => {
  const f = await fixture(t), now = Date.parse("2026-10-09T12:00:00.000Z");
  await writeFile(path.join(f.source, "data"), "data");
  const capture = (id: string, ago: number) => captureWakeSnapshot({ directory: f.directory, root: { id, path: f.source }, startedAt: new Date(now - ago).toISOString(), executionId: "execution" });
  const old = await capture("state", 5000), latest = await capture("state", 2000), only = await capture("removed-root", 3000);
  for (const ago of [5000, 2000, 500]) await appendWakeMomentRow(f.directory, row(new Date(now - ago).toISOString()));
  const base = path.join(f.directory, "snapshots", "state");
  const foreign = "20260101T000000000Z-foreign";
  await mkdir(path.join(base, foreign)); await writeFile(path.join(base, foreign, "keep"), "foreign");
  await writeFile(path.join(base, `${foreign}.manifest.json`), "{}");
  await writeFile(path.join(base, "notes.txt"), "foreign");
  await mkdir(path.join(base, `${foreign}.partial`));
  await symlink(f.source, path.join(base, "20260101T000000000Z-symlink"));
  await writeFile(path.join(f.directory, "foreign.txt"), "foreign");
  await appendWakeMomentRow(f.directory, { ...row(new Date(now - 5000).toISOString()), version: "foreign" as never });
  await pruneWakeMoments(f.recording, "agent", now);
  await assert.rejects(lstat(path.join(base, old.snapshot.snapshot)), /ENOENT/);
  await assert.rejects(lstat(path.join(base, `${old.snapshot.snapshot}.manifest.json`)), /ENOENT/);
  assert.ok((await lstat(path.join(base, latest.snapshot.snapshot))).isDirectory());
  assert.ok((await lstat(path.join(f.directory, "snapshots", "removed-root", only.snapshot.snapshot))).isDirectory());
  const remaining = (await readFile(f.rows, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(remaining.length, 2); assert.equal(remaining[0].started_at, new Date(now - 500).toISOString());
  assert.equal(remaining[1].version, "foreign");
  for (const name of [foreign, `${foreign}.manifest.json`, `${foreign}.partial`, "notes.txt", "20260101T000000000Z-symlink"]) await lstat(path.join(base, name));
  assert.equal(await readFile(path.join(f.directory, "foreign.txt"), "utf8"), "foreign");
  const before = await lstat(f.rows);
  await pruneWakeMoments(f.recording, "agent", now);
  assert.equal((await lstat(f.rows)).ino, before.ino, "nothing pruned means no rewrite");
});

test("failed roots are omitted, errors are bounded/redacted, and replay attempts append rows", async (t) => {
  const f = await fixture(t);
  await symlink(f.source, path.join(f.root, "secret-token-target"));
  const agent = { ...f.agent, recording: { ...f.recording, snapshots: [
    { id: "bad", path: path.join(f.root, "secret-token-target") },
    { id: "missing", path: path.join(f.root, "missing") }, { id: "good", path: f.source }
  ] } };
  for (let i = 0; i < 2; i++) await recordWakeMoment(agent, "same-execution", []);
  const rows: WakeMomentRow[] = (await readFile(f.rows, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.execution_id, "same-execution"); assert.match(r.started_at, /^\d{4}-.*\.\d{3}Z$/);
    assert.deepEqual(r.snapshots.map((s) => s.id), ["missing", "good"]);
    assert.match(r.error!, /bad: recording_io_failed/); assert.match(r.error!, /missing: root_missing/);
    assert.doesNotMatch(r.error!, /secret-token-target/); assert.ok(r.error!.length <= 2048);
  }
  assert.deepEqual(await readdir(path.join(f.directory, "snapshots", "bad")), []);
});

test("unreadable roots and unwritable row stores remain advisory", async (t) => {
  if (process.getuid?.() === 0) { t.skip("POSIX permission refusals require an unprivileged uid"); return; }
  const f = await fixture(t);
  await chmod(f.source, 0);
  try { await recordWakeMoment(f.agent, "unreadable", []); } finally { await chmod(f.source, 0o700); }
  const recorded = JSON.parse(await readFile(f.rows, "utf8"));
  assert.match(recorded.error, /EACCES|EPERM/); assert.deepEqual(recorded.snapshots, []);
  await rm(f.rows); await mkdir(f.rows);
  const logs: string[] = []; t.mock.method(console, "error", (message: string) => logs.push(message));
  await assert.doesNotReject(recordWakeMoment(f.agent, "failed-row", []));
  assert.equal(logs.length, 1); assert.match(logs[0]!, /wake recording failed/); assert.doesNotMatch(logs[0]!, new RegExp(f.root));
});

test("line bounds refuse oversized writes and bound retention reads, preserving existing bytes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(appendWakeMomentRow(f.directory, row("2026-01-01T00:00:00.000Z", "x".repeat(WAKE_MOMENTS.maxRowBytes))), /row_size_limit/);
  await assert.rejects(lstat(f.rows), /ENOENT/);
  const bytes = "x".repeat(WAKE_MOMENTS.maxRowBytes + 1);
  await writeFile(f.rows, bytes);
  await assert.rejects(pruneWakeMoments(f.recording, "agent"), /row_size_limit/);
  assert.equal((await lstat(f.rows)).size, bytes.length);
  assert.deepEqual(await readdir(f.directory), [WAKE_MOMENTS.rowsFile]);
});

test("a torn final row cannot swallow the next complete attempt", async (t) => {
  const f = await fixture(t);
  await writeFile(f.rows, '{"version":"torn');
  await appendWakeMomentRow(f.directory, row("2026-10-09T12:00:00.000Z"));
  const lines = (await readFile(f.rows, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2); assert.equal(JSON.parse(lines[1]!).execution_id, "execution");
});

test("recording off returns before any filesystem access", async (t) => {
  const f = await fixture(t), { recording: _unused, ...agent } = f.agent;
  await rm(f.directory, { recursive: true });
  await recordWakeMoment(agent, "off", []);
  await assert.rejects(lstat(f.directory), /ENOENT/);
  assert.deepEqual(await readdir(f.root), ["source"]);
});

test("retention keeps the last completed attempt when capture timestamps tie", async (t) => {
  const f = await fixture(t), startedAt = "2026-01-01T00:00:00.000Z";
  await writeFile(path.join(f.source, "data"), "first");
  const first = await captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt, executionId: "zzz-first" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(path.join(f.source, "data"), "second");
  const second = await captureWakeSnapshot({ directory: f.directory, root: f.recording.snapshots[0]!, startedAt, executionId: "aaa-second" });
  await pruneWakeMoments(f.recording, "agent", Date.parse(startedAt) + 10000);
  const base = path.join(f.directory, "snapshots", "state");
  await assert.rejects(lstat(path.join(base, first.snapshot.snapshot)), /ENOENT/);
  assert.equal(await readFile(path.join(base, second.snapshot.snapshot, "data"), "utf8"), "second");
});
