import { constants, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { assertNoSymlinkComponents, assertRuntimeDirectory, identity, sameIdentity } from "./physicalReadiness.js";
import { WakeMomentFault, WakeMomentIo } from "./wakeMomentIo.js";
export { WakeMomentFault } from "./wakeMomentIo.js";

/** Diagnostics never include source paths, file contents, or arbitrary exception text. */
export function wakeMomentFailure(error: unknown): string {
  if (error instanceof WakeMomentFault) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EIO", "ELOOP", "ENOTDIR", "EEXIST", "EMFILE", "ENAMETOOLONG", "EXDEV"].includes(code ?? "") ? code! : "recording_io_failed";
}

export type MomentStore = { verify(io: WakeMomentIo, target?: string): Promise<void>; close(): Promise<void> };

/** Pin the caller's root, then re-check the same dev/ino/uid/mode at every write boundary. */
export async function pinMomentStore(directory: string, io: WakeMomentIo, verifyPrepared?: () => Promise<void>): Promise<MomentStore> {
  await assertNoSymlinkComponents(directory, io.fs.lstat);
  const before = await io.fs.lstat(directory);
  assertPrivate(before);
  // A raw handle is shared by the capture and separately bounded finalization scopes.
  const fd = await io.call("pinStore", () => open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  const expected = identity(before);
  const store: MomentStore = {
    async verify(scope, target) {
      try {
        await scope.call("verifyPreparedStore", async () => { await verifyPrepared?.(); });
        await assertNoSymlinkComponents(directory, scope.fs.lstat);
        const entry = await scope.fs.lstat(directory);
        const opened = await scope.call("statStore", () => fd.stat());
        assertPrivate(entry);
        if (!sameIdentity(expected, identity(entry)) || !sameIdentity(expected, identity(opened))) throw new Error("changed");
        if (target?.startsWith(`${directory}${path.sep}`)) await assertNoSymlinkComponents(path.dirname(target), scope.fs.lstat);
      } catch {
        scope.check();
        throw new WakeMomentFault("recording_store_changed");
      }
    },
    close: () => fd.close()
  };
  try { await store.verify(io); return store; }
  catch (error) { void fd.close().catch(() => undefined); throw error; }
}

function assertPrivate(entry: Stats): void {
  assertRuntimeDirectory(entry, "recording.directory", "private", { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 });
}

export async function openMomentDirectory(directory: string, io = new WakeMomentIo()): Promise<FileHandle> {
  await assertNoSymlinkComponents(directory, io.fs.lstat);
  const fd = await io.fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { assertPrivate(await fd.stat()); return fd; }
  catch (error) { await fd.close(); throw error; }
}

export async function ensureMomentDirectory(directory: string, io = new WakeMomentIo()): Promise<void> {
  let created = false;
  try { await io.fs.mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = await openMomentDirectory(directory, io);
  try { await fd.sync(); } finally { await fd.close(); }
  if (created) await syncMomentDirectory(path.dirname(directory), io);
}

export async function syncMomentDirectory(directory: string, io = new WakeMomentIo()): Promise<void> {
  const fd = await io.fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

/** Refuses symlinks, special files and hard-linked metadata, including a FIFO before it can block. */
export async function openMomentFile(file: string, flags = constants.O_RDONLY, io = new WakeMomentIo()): Promise<FileHandle> {
  const fd = await io.fs.open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new WakeMomentFault("invalid_metadata_file");
    return fd;
  } catch (error) { await fd.close(); throw error; }
}

export function manifestBytes(value: unknown, max = WAKE_MOMENTS.maxManifestBytes as number): string {
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > Math.min(max, WAKE_MOMENTS.maxManifestBytes)) throw new WakeMomentFault("manifest_size_limit");
  return bytes;
}

export async function readMomentJson(file: string, io = new WakeMomentIo(), max = WAKE_MOMENTS.maxManifestBytes as number): Promise<unknown> {
  const fd = await openMomentFile(file, constants.O_RDONLY, io);
  try {
    const limit = Math.min(max, WAKE_MOMENTS.maxManifestBytes);
    if ((await fd.stat()).size > limit) throw new WakeMomentFault("manifest_size_limit");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new WakeMomentFault("manifest_size_limit");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  } finally { await fd.close(); }
}

/** Unlike FileHandle.writeFile, each syscall is admitted through the cancellation fence. */
export async function writeMomentBytes(fd: FileHandle, bytes: string | Buffer): Promise<void> {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  for (let offset = 0; offset < buffer.length;) {
    const { bytesWritten } = await fd.write(buffer, offset, Math.min(64 * 1024, buffer.length - offset), null);
    if (!bytesWritten) throw new WakeMomentFault("short_write");
    offset += bytesWritten;
  }
}

export async function writeMomentJson(file: string, bytes: string, io: WakeMomentIo, cleanup: Set<string>): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  cleanup.add(temporary);
  const fd = await openMomentFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, io);
  try {
    await writeMomentBytes(fd, bytes); await fd.sync(); await fd.close();
    await io.fs.rename(temporary, file); cleanup.delete(temporary);
    await syncMomentDirectory(path.dirname(file), io);
  } finally { await fd.close(); }
}

export async function momentPathExists(target: string, io = new WakeMomentIo()): Promise<boolean> {
  try { await io.fs.lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Never recurse until root identity AND the target's parent components have just been verified. */
export async function cleanMomentPaths(paths: Set<string>, store: MomentStore, io: WakeMomentIo): Promise<void> {
  for (const target of paths) {
    await removeMomentPath(target, store, io);
    paths.delete(target);
  }
}

/** Explicit traversal keeps recursive cleanup cancellable between individual filesystem calls. */
export async function removeMomentPath(target: string, store: MomentStore, io: WakeMomentIo): Promise<void> {
  await store.verify(io, target);
  let entry: Stats;
  try { entry = await io.fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (entry.isDirectory()) {
    await assertNoSymlinkComponents(target, io.fs.lstat);
    for await (const child of await io.fs.opendir(target)) await removeMomentPath(path.join(target, child.name), store, io);
    await store.verify(io, target);
    await io.fs.rmdir(target);
  } else {
    await store.verify(io, target);
    await io.fs.unlink(target);
  }
}
