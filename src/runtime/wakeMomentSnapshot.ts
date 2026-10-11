import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, readlink, rename, rm, symlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { assertNoSymlinkComponents } from "./physicalReadiness.js";
import { ensureMomentDirectory, momentPathExists, readMomentJson, syncMomentDirectory, WakeMomentFault, writeMomentJson } from "./wakeMomentFs.js";

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

/** A complete snapshot needs BOTH a real directory and its published, identifying manifest. */
export async function completeSnapshotNames(directory: string): Promise<string[]> {
  const names: { name: string; time: number; published: bigint }[] = [];
  try {
    for await (const entry of await opendir(directory)) {
      if (!entry.isFile() || !entry.name.endsWith(".manifest.json")) continue;
      const name = entry.name.slice(0, -".manifest.json".length);
      const time = snapshotTime(name);
      if (Number.isFinite(time) && (await lstat(path.join(directory, name)).catch(() => undefined))?.isDirectory()) {
        names.push({ name, time, published: (await lstat(path.join(directory, entry.name), { bigint: true })).mtimeNs });
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Two recovery attempts can start in the same millisecond: publication orders the tie.
  return names.sort((a, b) => b.time - a.time || (a.published < b.published ? 1 : a.published > b.published ? -1 : b.name.localeCompare(a.name))).map(({ name }) => name);
}

export async function readSnapshotManifest(directory: string, name: string, id: string): Promise<WakeSnapshotManifest | undefined> {
  try {
    const value = await readMomentJson(path.join(directory, `${name}.manifest.json`)) as WakeSnapshotManifest;
    if (!value || value.version !== WAKE_MOMENTS.version || value.id !== id || value.snapshot !== name || Date.parse(value.started_at) !== snapshotTime(name)
      || typeof value.sourcePath !== "string" || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)
      || Object.keys(value.entries).length > WAKE_MOMENTS.maxSnapshotEntries) return undefined;
    return value;
  } catch { return undefined; }
}

/** SOURCE identity, never the copied inode's metadata: ordinary writers cannot restore ctime. */
export function sameSnapshotSource(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}
function identity(stat: BigIntStats): Identity {
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), mode: Number(stat.mode) };
}

export async function captureWakeSnapshot(input: {
  directory: string; root: { id: string; path: string }; startedAt: string; executionId: string;
  /** Tests may lower the bound; production always uses the manifest's cap. */
  maxEntries?: number;
}): Promise<{ snapshot: WakeSnapshot; note?: string }> {
  const namespace = path.join(input.directory, WAKE_MOMENTS.snapshotsDirectory);
  await ensureMomentDirectory(namespace);
  const base = path.join(namespace, snapshotRootName(input.root.id));
  await ensureMomentDirectory(base);
  let name = snapshotName(input.startedAt, input.executionId);
  if (await momentPathExists(path.join(base, name)) || await momentPathExists(path.join(base, `${name}.partial`)) || await momentPathExists(path.join(base, `${name}.manifest.json`))) name += `-${randomUUID()}`;
  const partial = path.join(base, `${name}.partial`), destination = path.join(base, name);
  const previousNames = await completeSnapshotNames(base);
  let previous: WakeSnapshotManifest | undefined;
  for (const candidate of previousNames) {
    previous = await readSnapshotManifest(base, candidate, input.root.id);
    if (previous) break;
  }
  if (previous?.sourcePath !== input.root.path) previous = undefined;
  const manifest: WakeSnapshotManifest = { version: WAKE_MOMENTS.version, id: input.root.id, snapshot: name, started_at: input.startedAt, sourcePath: input.root.path, entries: Object.create(null) as Record<string, SnapshotEntry> };
  const snapshot: WakeSnapshot = { id: input.root.id, snapshot: name, files: 0, copied: 0, linked: 0, skipped: 0 };
  const max = Math.min(input.maxEntries ?? WAKE_MOMENTS.maxSnapshotEntries, WAKE_MOMENTS.maxSnapshotEntries);
  let entries = 0, published = false, note: string | undefined;
  await mkdir(partial, { mode: 0o700 });
  try {
    let root: FileHandle | undefined;
    try { await assertNoSymlinkComponents(input.root.path); root = await openSourceDirectory(input.root.path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") note = "root_missing"; else throw error; }
    if (root) {
      try { await walk(root, input.root.path, ""); } finally { await root.close(); }
    }
    await syncMomentDirectory(partial);
    await rename(partial, destination); published = true;
    await syncMomentDirectory(base);
    await writeMomentJson(path.join(base, `${name}.manifest.json`), manifest);
    return { snapshot, ...(note ? { note } : {}) };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    if (published) {
      await rm(path.join(base, `${name}.manifest.json`), { force: true });
      await rm(destination, { recursive: true, force: true });
    }
    throw error;
  }

  async function walk(directory: FileHandle, source: string, relative: string): Promise<void> {
    // Linux's descriptor-relative paths pin ancestors against a concurrent rename/symlink swap.
    const anchored = process.platform === "linux" ? `/proc/self/fd/${directory.fd}` : source;
    for await (const entry of await opendir(anchored)) {
      if (++entries > max) throw new WakeMomentFault("snapshot_entry_limit");
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const from = path.join(anchored, entry.name), to = path.join(partial, rel);
      const stat = await lstat(from, { bigint: true }), sourceIdentity = identity(stat);
      if (stat.isDirectory()) {
        const child = await openSourceDirectory(from);
        try {
          if (!sameSnapshotSource(sourceIdentity, identity(await child.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          await mkdir(to, { mode: 0o700 });
          manifest.entries[rel] = { type: "directory", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity };
          await walk(child, from, rel); await syncMomentDirectory(to);
        } finally { await child.close(); }
      } else if (stat.isSymbolicLink()) {
        const target = await readlink(from);
        await symlink(target, to);
        manifest.entries[rel] = { type: "symlink", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity, target };
      } else if (stat.isFile()) {
        const sourceFile = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!sameSnapshotSource(sourceIdentity, identity(await sourceFile.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          const prior = previous && Object.hasOwn(previous.entries, rel) ? previous.entries[rel] : undefined;
          if (prior?.type === "file" && prior.source && sameSnapshotSource(prior.source, sourceIdentity)) {
            const old = path.join(base, previous!.snapshot, rel);
            await assertNoSymlinkComponents(path.dirname(old));
            if (!(await lstat(old)).isFile()) throw new WakeMomentFault("invalid_link_base");
            await link(old, to); snapshot.linked++;
          } else { await copyFile(sourceFile, to, stat); snapshot.copied++; }
          if (!sameSnapshotSource(sourceIdentity, identity(await sourceFile.stat({ bigint: true })))) throw new WakeMomentFault("source_changed");
          manifest.entries[rel] = { type: "file", mode: Number(stat.mode), size: String(stat.size), source: sourceIdentity }; snapshot.files++;
        } finally { await sourceFile.close(); }
      } else snapshot.skipped++;
    }
  }
}

async function openSourceDirectory(source: string): Promise<FileHandle> {
  if (process.platform !== "linux" || !source.startsWith("/proc/self/fd/")) await assertNoSymlinkComponents(source);
  return open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function copyFile(source: FileHandle, target: string, stat: BigIntStats): Promise<void> {
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new WakeMomentFault("source_size_limit");
  const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
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
