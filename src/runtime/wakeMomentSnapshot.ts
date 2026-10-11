import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { assertNoSymlinkComponents } from "./physicalReadiness.js";
import { cleanMomentPaths, ensureMomentDirectory, manifestBytes, momentPathExists, openMomentFile, pinMomentStore, readMomentJson, syncMomentDirectory, WakeMomentFault, writeMomentJson, type MomentStore } from "./wakeMomentFs.js";

import { WakeMomentIo } from "./wakeMomentIo.js";

type Identity = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; mode: number };
export type SnapshotEntry = { type: "file" | "directory" | "symlink"; mode: number; size: string; source: Identity; target?: string };
export type WakeSnapshotManifest = {
  version: typeof WAKE_MOMENTS.version; id: string; snapshot: string; started_at: string; sourcePath: string;
  entries: Record<string, SnapshotEntry>;
};
export type WakeSnapshot = { id: string; snapshot: string; files: number; copied: number; linked: number; skipped: number };
export const SNAPSHOT_NAME = /^\d{8}T\d{9}Z-[A-Za-z0-9._-]{1,200}$/;
export const snapshotRootName = (id: string): string => id === "." || id === ".." ? id.replaceAll(".", "%2E") : id;

export function snapshotName(startedAt: string, executionId: string): string {
  const execution = /^[A-Za-z0-9._-]{1,128}$/.test(executionId) ? executionId : `sha256-${createHash("sha256").update(executionId).digest("hex")}`;
  return `${startedAt.replace(/[-:.]/g, "")}-${execution}`;
}

export function snapshotTime(name: string): number {
  if (!SNAPSHOT_NAME.test(name)) return NaN;
  const value = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}.${name.slice(15, 18)}Z`;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}

/** Completion markers establish ownership without rereading historical manifests. */
export async function completeSnapshotNames(directory: string, io = new WakeMomentIo()): Promise<string[]> {
  try {
    const entries = await io.fs.readdir(directory, { withFileTypes: true });
    const directories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
    const markers = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith(WAKE_MOMENTS.completionSuffix)).map((entry) => entry.name.slice(0, -WAKE_MOMENTS.completionSuffix.length)));
    const names = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".manifest.json"))
      .map((entry) => entry.name.slice(0, -".manifest.json".length))
      .filter((name) => Number.isFinite(snapshotTime(name)) && directories.has(name) && markers.has(name))
      .sort((a, b) => snapshotTime(b) - snapshotTime(a) || b.localeCompare(a));
    // Only timestamp ties need publication metadata; no historical manifest contents are read.
    const stamps = new Map<string, bigint>();
    for (let i = 0; i < names.length; i++) if (snapshotTime(names[i]!) === snapshotTime(names[i - 1] ?? "") || snapshotTime(names[i]!) === snapshotTime(names[i + 1] ?? "")) {
      stamps.set(names[i]!, (await io.fs.lstat(path.join(directory, `${names[i]}.manifest.json`), { bigint: true })).mtimeNs);
    }
    return names.sort((a, b) => snapshotTime(b) - snapshotTime(a) || ((stamps.get(a) ?? 0n) < (stamps.get(b) ?? 0n) ? 1 : (stamps.get(a) ?? 0n) > (stamps.get(b) ?? 0n) ? -1 : b.localeCompare(a)));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function readSnapshotManifest(directory: string, name: string, id: string, io = new WakeMomentIo(), maxManifestBytes = WAKE_MOMENTS.maxManifestBytes as number): Promise<WakeSnapshotManifest | undefined> {
  try {
    const value = await readMomentJson(path.join(directory, `${name}.manifest.json`), io, maxManifestBytes) as WakeSnapshotManifest;
    if (!value || value.version !== WAKE_MOMENTS.version || value.id !== id || value.snapshot !== name || Date.parse(value.started_at) !== snapshotTime(name)
      || typeof value.sourcePath !== "string" || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)
      || Object.keys(value.entries).length > WAKE_MOMENTS.maxSnapshotEntries) return undefined;
    return value;
  } catch { io.check(); return undefined; }
}

/** SOURCE identity, never the copied inode's metadata: ordinary writers cannot restore ctime. */
export function sameSnapshotSource(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}
function identity(stat: BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), mode: Number(stat.mode) };
}

type CaptureInput = {
  directory: string; root: { id: string; path: string }; startedAt: string; executionId: string;
  /** Internal test bounds; not caller configuration. */
  maxEntries?: number; maxManifestBytes?: number;
  io?: WakeMomentIo; cleanup?: Set<string>;
};

export async function captureWakeSnapshot(input: CaptureInput): Promise<{ snapshot: WakeSnapshot; note?: string }> {
  if (input.io && input.cleanup) return capture(input, input.io, input.cleanup);
  const io = new WakeMomentIo(), cleanup = new Set<string>();
  let store: MomentStore | undefined;
  try {
    return await io.bounded(WAKE_MOMENTS.captureDeadlineMs, async () => {
      store = await pinMomentStore(input.directory, io);
      io.verifyWrite = (target) => store!.verify(io, target);
      return capture(input, io, cleanup);
    });
  } finally {
    if (store) {
      const finalizer = new WakeMomentIo();
      finalizer.verifyWrite = (target) => store!.verify(finalizer, target);
      try { await finalizer.bounded(WAKE_MOMENTS.finalizationDeadlineMs, () => cleanMomentPaths(cleanup, store!, finalizer)); }
      finally { void store.close().catch(() => undefined); }
    }
  }
}

async function capture(input: CaptureInput, io: WakeMomentIo, cleanup: Set<string>): Promise<{ snapshot: WakeSnapshot; note?: string }> {
  const namespace = path.join(input.directory, WAKE_MOMENTS.snapshotsDirectory);
  await ensureMomentDirectory(namespace, io);
  const base = path.join(namespace, snapshotRootName(input.root.id));
  await ensureMomentDirectory(base, io);
  let name = snapshotName(input.startedAt, input.executionId);
  if (await momentPathExists(path.join(base, name), io) || await momentPathExists(path.join(base, `${name}.partial`), io) || await momentPathExists(path.join(base, `${name}.manifest.json`), io)) name += `-${randomUUID()}`;
  const partial = path.join(base, `${name}.partial`), destination = path.join(base, name);
  const previousName = (await completeSnapshotNames(base, io))[0];
  let previous = previousName ? await readSnapshotManifest(base, previousName, input.root.id, io, input.maxManifestBytes) : undefined;
  if (previous?.sourcePath !== input.root.path) previous = undefined;
  const manifest: WakeSnapshotManifest = { version: WAKE_MOMENTS.version, id: input.root.id, snapshot: name, started_at: input.startedAt, sourcePath: input.root.path, entries: Object.create(null) as Record<string, SnapshotEntry> };
  const snapshot: WakeSnapshot = { id: input.root.id, snapshot: name, files: 0, copied: 0, linked: 0, skipped: 0 };
  const max = Math.min(input.maxEntries ?? WAKE_MOMENTS.maxSnapshotEntries, WAKE_MOMENTS.maxSnapshotEntries);
  let entries = 0, note: string | undefined;
  cleanup.add(partial);
  await io.fs.mkdir(partial, { mode: 0o700 });
  {
    let root: FileHandle | undefined;
    try { await assertNoSymlinkComponents(input.root.path, io.fs.lstat); root = await openSourceDirectory(input.root.path, io); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") note = "root_missing"; else throw error; }
    if (root) {
      try { await walk(root, input.root.path, ""); } finally { await root.close(); }
    }
    // The writer enforces exactly the reader's byte bound BEFORE either publication rename.
    const bytes = manifestBytes(manifest, input.maxManifestBytes);
    await syncMomentDirectory(partial, io);
    cleanup.add(destination);
    await io.fs.rename(partial, destination); cleanup.delete(partial);
    await syncMomentDirectory(base, io);
    const manifestPath = path.join(base, `${name}.manifest.json`);
    cleanup.add(manifestPath);
    await writeMomentJson(manifestPath, bytes, io, cleanup);
    const markerPath = path.join(base, `${name}${WAKE_MOMENTS.completionSuffix}`);
    cleanup.add(markerPath);
    const marker = await openMomentFile(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, io);
    try { await marker.sync(); } finally { await marker.close(); }
    await syncMomentDirectory(base, io);
    cleanup.delete(markerPath); cleanup.delete(manifestPath); cleanup.delete(destination);
    return { snapshot, ...(note ? { note } : {}) };
  }

  async function walk(directory: FileHandle, source: string, relative: string): Promise<void> {
    // Linux's descriptor-relative paths pin ancestors against a concurrent rename/symlink swap.
    const anchored = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : source;
    for await (const entry of await io.fs.opendir(anchored)) {
      if (++entries > max) throw new WakeMomentFault("snapshot_entry_limit");
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(anchored, entry.name), to = path.join(partial, rel);
      const stat = await io.fs.lstat(from, { bigint: true }), sourceIdentity = identity(stat);
      if (stat.isDirectory()) {
        const child = await openSourceDirectory(from, io);
        try {
          if (!sameSnapshotSource(sourceIdentity, identity(await child.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          await io.fs.mkdir(to, { mode: 0o700 });
          manifest.entries[rel] = { type: "directory", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity };
          await walk(child, from, rel); await syncMomentDirectory(to, io);
        } finally { await child.close(); }
      } else if (stat.isSymbolicLink()) {
        const target = await io.fs.readlink(from);
        await io.fs.symlink(target, to);
        manifest.entries[rel] = { type: "symlink", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity, target };
      } else if (stat.isFile()) {
        const sourceFile = await io.fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!sameSnapshotSource(sourceIdentity, identity(await sourceFile.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          const prior = previous && Object.hasOwn(previous.entries, rel) ? previous.entries[rel] : undefined;
          if (prior?.type === "file" && prior.source && sameSnapshotSource(prior.source, sourceIdentity)) {
            const old = path.join(base, previous!.snapshot, rel);
            await assertNoSymlinkComponents(path.dirname(old), io.fs.lstat);
            if (!(await io.fs.lstat(old)).isFile()) throw new WakeMomentFault("invalid_link_base");
            await io.fs.link(old, to); snapshot.linked++;
          } else { await copyFile(sourceFile, to, stat, io); snapshot.copied++; }
          if (!sameSnapshotSource(sourceIdentity, identity(await sourceFile.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          manifest.entries[rel] = { type: "file", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity }; snapshot.files++;
        } finally { await sourceFile.close(); }
      } else snapshot.skipped++;
    }
  }
}

async function openSourceDirectory(source: string, io: WakeMomentIo): Promise<FileHandle> {
  if (process.platform !== "linux" || !source.startsWith("/proc/self/fd/")) await assertNoSymlinkComponents(source, io.fs.lstat);
  return io.fs.open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function copyFile(source: FileHandle, target: string, stat: BigIntStats, io: WakeMomentIo): Promise<void> {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WakeMomentFault("source_size_limit");
  const output = await io.fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < Number(stat.size)) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, Number(stat.size) - position), position);
      if (!bytesRead) throw new WakeMomentFault("source_changed");
      let written = 0;
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written);
        if (!result.bytesWritten) throw new WakeMomentFault("short_write");
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await output.chmod(Number(stat.mode) & 0o777); await output.sync();
  } finally { await output.close(); }
}
