import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { WAKE_MOMENTS, type WakeMomentRecording } from "../contracts/wakeMomentContract.js";
import { cleanMomentPaths, openMomentDirectory, openMomentFile, pinMomentStore, removeMomentPath, syncMomentDirectory, writeMomentBytes, type MomentStore } from "./wakeMomentFs.js";
import { WakeMomentIo } from "./wakeMomentIo.js";
import { momentLines } from "./wakeMomentRows.js";
import type { WakeMomentRow } from "./wakeMomentRecorder.js";
import type { WakeSnapshot } from "./wakeMomentSnapshot.js";
import { completeSnapshotNames, eligibleSnapshot, indexFromNames, latestSnapshotIndex, snapshotRootName, snapshotTime, writeSnapshotIndex } from "./wakeMomentHistory.js";

const sweeps = new Map<string, number>();
const key = (snapshot: WakeSnapshot): string => `${snapshot.id}/${snapshot.snapshot}`;

function expiredRow(line: Buffer, agentId: string, cutoff: number, current?: WakeMomentRow): WakeMomentRow | undefined {
  try {
    const row = JSON.parse(line.toString("utf8")) as WakeMomentRow;
    if (current && row.execution_id === current.execution_id && row.started_at === current.started_at) return undefined;
    if (row?.version === WAKE_MOMENTS.version && row.agent_id === agentId && typeof row.execution_id === "string"
      && Array.isArray(row.deliveries) && Array.isArray(row.snapshots) && typeof row.started_at === "string"
      && new Date(row.started_at).toISOString() === row.started_at && Date.parse(row.started_at) < cutoff) return row;
  } catch { /* Unknown/partial lines are not ours to delete. */ }
  return undefined;
}

/** First-line age check; a full sweep every 64 calls also handles foreign prefixes/clock rollback. */
export async function pruneWakeMoments(recording: WakeMomentRecording, agentId: string, now = Date.now(), current?: WakeMomentRow, scope?: WakeMomentIo, authority?: MomentStore): Promise<void> {
  const io = scope ?? new WakeMomentIo();
  const store = authority ?? await pinMomentStore(recording.directory, io);
  io.verifyWrite = (target) => store.verify(io, target);
  try {
    const cutoff = now - recording.keepMs;
    await pruneSnapshots(recording.directory, new Set(current?.snapshots.map(key) ?? []), cutoff, io, store);
    await pruneRows(recording, agentId, cutoff, current, io, store);
  }
  finally { if (!authority) await store.close(); }
}

async function pruneRows(recording: WakeMomentRecording, agentId: string, cutoff: number, current: WakeMomentRow | undefined, io: WakeMomentIo, store: MomentStore): Promise<void> {
  const target = path.join(recording.directory, WAKE_MOMENTS.rowsFile);
  let source: FileHandle;
  try { source = await openMomentFile(target, constants.O_RDONLY, io); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const temporary = `${target}.${randomUUID()}.tmp`;
  let output: FileHandle | undefined, changed = false, created = false;
  try {
    const count = (sweeps.get(target) ?? 0) + 1;
    sweeps.set(target, count % 64);
    let firstExpired = false;
    for await (const line of momentLines(source)) { firstExpired = expiredRow(line, agentId, cutoff, current) !== undefined; break; }
    if (!firstExpired && count % 64 !== 0) return;
    output = await openMomentFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, io); created = true;
    const reread = await openMomentFile(target, constants.O_RDONLY, io);
    try {
      for await (const line of momentLines(reread)) {
        const expired = expiredRow(line, agentId, cutoff, current);
        if (!expired) { await writeMomentBytes(output, line); continue; }
        changed = true;
      }
    } finally { await reread.close(); }
    if (!changed) return;
    await output.sync(); await output.close(); output = undefined;
    await io.fs.rename(temporary, target); created = false;
    await syncMomentDirectory(recording.directory, io);
  } finally {
    await source.close(); await output?.close();
    if (created) await removeMomentPath(temporary, store, io);
  }
}

/** Age comes from names; ownership comes from the writer's zero-byte completion marker. */
async function pruneSnapshots(directory: string, protectedSnapshots: Set<string>, cutoff: number, io: WakeMomentIo, store: MomentStore): Promise<void> {
  const namespace = path.join(directory, WAKE_MOMENTS.snapshotsDirectory);
  try {
    const ns = await openMomentDirectory(namespace, io); await ns.close();
    for await (const root of await io.fs.opendir(namespace)) {
      if (!root.isDirectory() || !/^(?:[A-Za-z0-9._-]{1,128}|%2E|%2E%2E)$/.test(root.name)) continue;
      const id = root.name === "%2E" ? "." : root.name === "%2E%2E" ? ".." : root.name;
      if (snapshotRootName(id) !== root.name) continue;
      const base = path.join(namespace, root.name);
      const fd = await openMomentDirectory(base, io); await fd.close();
      const state = await latestSnapshotIndex(base, io);
      if (!state.names && (state.index!.oldest === null || snapshotTime(state.index!.oldest) >= cutoff)) continue;
      const names = state.names ?? await completeSnapshotNames(base, io), removed = new Set<string>();
      for (const name of names.slice(1)) {
        if (protectedSnapshots.has(`${id}/${name}`) || snapshotTime(name) >= cutoff) continue;
        const target = path.join(base, name), manifest = `${target}.manifest.json`, marker = `${target}${WAKE_MOMENTS.completionSuffix}`;
        await store.verify(io, target);
        if (!await eligibleSnapshot(base, name, io)) continue;
        await store.verify(io, target);
        await removeMomentPath(target, store, io);
        await removeMomentPath(manifest, store, io);
        await removeMomentPath(marker, store, io);
        await syncMomentDirectory(base, io);
        removed.add(name);
      }
      const index = indexFromNames(names.filter((name) => !removed.has(name)));
      if (index) {
        const cleanup = new Set<string>();
        try { await writeSnapshotIndex(base, index, io, cleanup); }
        finally { await cleanMomentPaths(cleanup, store, io); }
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
