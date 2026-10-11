import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, opendir, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { WAKE_MOMENTS, type WakeMomentRecording } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { StoredWakeAcceptanceRecord } from "./wakeAcceptanceRecord.js";
import { openMomentDirectory, openMomentFile, syncMomentDirectory, WakeMomentFault, wakeMomentFailure } from "./wakeMomentFs.js";
import { captureWakeSnapshot, completeSnapshotNames, readSnapshotManifest, snapshotRootName, snapshotTime, type WakeSnapshot } from "./wakeMomentSnapshot.js";

export type WakeMomentRow = {
  version: typeof WAKE_MOMENTS.version; agent_id: string; execution_id: string; started_at: string;
  deliveries: { acceptance_id: string; delivery_id: string; kind: string; occurred_at: string }[];
  snapshots: WakeSnapshot[]; error?: string;
};

/** Advisory, per attempt, and completely inert for an agent without recording. */
export async function recordWakeMoment(agent: OrganizationRuntimeAgentConfig, executionId: string, records: readonly StoredWakeAcceptanceRecord[]): Promise<void> {
  const recording = agent.recording;
  if (!recording) return;
  try {
    const directory = await openMomentDirectory(recording.directory);
    await directory.close();
    const errors: string[] = [];
    const row: WakeMomentRow = {
      version: WAKE_MOMENTS.version, agent_id: agent.id, execution_id: executionId, started_at: new Date().toISOString(),
      deliveries: records.map(({ acceptance_id, delivery_id, event }) => ({ acceptance_id, delivery_id, kind: event.kind, occurred_at: event.occurred_at })),
      snapshots: []
    };
    for (const root of recording.snapshots) {
      try {
        const captured = await captureWakeSnapshot({ directory: recording.directory, root, startedAt: row.started_at, executionId });
        row.snapshots.push(captured.snapshot);
        if (captured.note) errors.push(`${root.id}: ${captured.note}`);
      } catch (error) { errors.push(`${root.id}: ${wakeMomentFailure(error)}`); }
    }
    if (errors.length) row.error = errors.join("; ").slice(0, 2048);
    await appendWakeMomentRow(recording.directory, row);
    await pruneWakeMoments(recording, agent.id);
  } catch (error) {
    // Never log paths, delivery text, arbitrary exception text, or credentials.
    try { console.error(`daimon: wake recording failed: ${wakeMomentFailure(error)}`); } catch { /* logging is advisory too */ }
  }
}

/** One append write and fsync. A torn prior append is delimited, never mistaken for this attempt. */
export async function appendWakeMomentRow(directory: string, row: WakeMomentRow): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(row)}\n`);
  if (line.length > WAKE_MOMENTS.maxRowBytes) throw new WakeMomentFault("row_size_limit");
  const target = path.join(directory, WAKE_MOMENTS.rowsFile);
  let created = false, fd: FileHandle;
  try { fd = await openMomentFile(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = await openMomentFile(target, constants.O_RDWR | constants.O_APPEND);
  }
  try {
    const size = (await fd.stat()).size;
    const tail = Buffer.alloc(1);
    if (size) await fd.read(tail, 0, 1, size - 1);
    const bytes = size && tail[0] !== 10 ? Buffer.concat([Buffer.from("\n"), line]) : line;
    const { bytesWritten } = await fd.write(bytes);
    if (bytesWritten !== bytes.length) throw new WakeMomentFault("short_row_write");
    await fd.sync();
    if (created) await syncMomentDirectory(directory);
  } finally { await fd.close(); }
}

/** Bound memory even when a damaged/foreign rows file has no newlines. */
async function* momentLines(fd: FileHandle): AsyncGenerator<Buffer> {
  const chunk = Buffer.alloc(64 * 1024);
  let pending: Buffer[] = [], length = 0;
  for (;;) {
    const { bytesRead } = await fd.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    let start = 0;
    while (start < bytesRead) {
      const newline = chunk.indexOf(10, start);
      const end = newline >= start && newline < bytesRead ? newline + 1 : bytesRead;
      const part = Buffer.from(chunk.subarray(start, end));
      length += part.length;
      if (length > WAKE_MOMENTS.maxRowBytes) throw new WakeMomentFault("row_size_limit");
      pending.push(part);
      if (part[part.length - 1] === 10) { yield Buffer.concat(pending, length); pending = []; length = 0; }
      start = end;
    }
  }
  if (length) yield Buffer.concat(pending, length);
}

function expiredRow(line: Buffer, agentId: string, cutoff: number): boolean {
  try {
    const row = JSON.parse(line.toString("utf8")) as WakeMomentRow;
    return row?.version === WAKE_MOMENTS.version && row.agent_id === agentId && typeof row.execution_id === "string"
      && Array.isArray(row.deliveries) && Array.isArray(row.snapshots) && typeof row.started_at === "string"
      && new Date(row.started_at).toISOString() === row.started_at && Date.parse(row.started_at) < cutoff;
  } catch { return false; } // Unknown/partial lines are not ours to delete.
}

/** Rename only on actual pruning; do not change the inode of an untouched ledger. */
async function pruneRows(directory: string, agentId: string, cutoff: number): Promise<void> {
  const target = path.join(directory, WAKE_MOMENTS.rowsFile);
  let source: FileHandle;
  try { source = await openMomentFile(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let output: FileHandle | undefined, changed = false;
  try {
    // A first bounded pass avoids even a temporary rewrite when nothing expired.
    for await (const line of momentLines(source)) if (expiredRow(line, agentId, cutoff)) { changed = true; break; }
    if (!changed) return;
    output = await openMomentFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    const reread = await openMomentFile(target);
    try { for await (const line of momentLines(reread)) if (!expiredRow(line, agentId, cutoff)) await output.writeFile(line); }
    finally { await reread.close(); }
    await output.sync(); await output.close(); output = undefined;
    await rename(temporary, target); await syncMomentDirectory(directory);
  } finally {
    await source.close(); await output?.close(); await rm(temporary, { force: true });
  }
}

/** Only exact snapshot names with an identifying manifest can be deleted. */
export async function pruneWakeMoments(recording: WakeMomentRecording, agentId: string, now = Date.now()): Promise<void> {
  const cutoff = now - recording.keepMs;
  const namespace = path.join(recording.directory, WAKE_MOMENTS.snapshotsDirectory);
  try {
    const ns = await openMomentDirectory(namespace); await ns.close();
    for await (const root of await opendir(namespace)) {
      if (!root.isDirectory() || !/^(?:[A-Za-z0-9._-]{1,128}|%2E|%2E%2E)$/.test(root.name)) continue;
      const id = root.name === "%2E" ? "." : root.name === "%2E%2E" ? ".." : root.name;
      if (snapshotRootName(id) !== root.name) continue;
      const base = path.join(namespace, root.name);
      const fd = await openMomentDirectory(base); await fd.close();
      let newest = true;
      for (const name of await completeSnapshotNames(base)) {
        if (!await readSnapshotManifest(base, name, id)) continue;
        if (newest) { newest = false; continue; }
        if (snapshotTime(name) >= cutoff) continue;
        // A foreign link is never followed, even if it uses a snapshot-shaped name.
        if (!(await lstat(path.join(base, name))).isDirectory()) continue;
        await rm(path.join(base, name), { recursive: true });
        await rm(path.join(base, `${name}.manifest.json`));
        await syncMomentDirectory(base);
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await pruneRows(recording.directory, agentId, cutoff);
}
