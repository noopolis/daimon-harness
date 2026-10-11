import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertNoSymlinkComponents, assertRuntimeDirectory } from "./physicalReadiness.js";

export class WakeMomentFault extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Diagnostics never include source paths, file contents, or arbitrary exception text. */
export function wakeMomentFailure(error: unknown): string {
  if (error instanceof WakeMomentFault) return error.reason;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return ["EACCES", "EPERM", "ENOENT", "ENOSPC", "EIO", "ELOOP", "ENOTDIR", "EEXIST", "EMFILE", "ENAMETOOLONG", "EXDEV"].includes(code ?? "") ? code! : "recording_io_failed";
}

export async function openMomentDirectory(directory: string): Promise<FileHandle> {
  await assertNoSymlinkComponents(directory);
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    assertRuntimeDirectory(await fd.stat(), "recording.directory", "private", { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 });
    return fd;
  } catch (error) { await fd.close(); throw error; }
}

export async function ensureMomentDirectory(directory: string): Promise<void> {
  let created = false;
  try { await mkdir(directory, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const fd = await openMomentDirectory(directory);
  try { await fd.sync(); } finally { await fd.close(); }
  if (created) await syncMomentDirectory(path.dirname(directory));
}

export async function syncMomentDirectory(directory: string): Promise<void> {
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

/** Refuses symlinks, special files and hard-linked metadata, including a FIFO before it can block. */
export async function openMomentFile(file: string, flags = constants.O_RDONLY): Promise<FileHandle> {
  const fd = await open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new WakeMomentFault("invalid_metadata_file");
    return fd;
  } catch (error) { await fd.close(); throw error; }
}

export async function readMomentJson(file: string): Promise<unknown> {
  const fd = await openMomentFile(file);
  try {
    if ((await fd.stat()).size > 128 * 1024 * 1024) throw new WakeMomentFault("manifest_size_limit");
    return JSON.parse(await fd.readFile("utf8")) as unknown;
  } finally { await fd.close(); }
}

export async function writeMomentJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await openMomentFile(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    await fd.writeFile(JSON.stringify(value)); await fd.sync(); await fd.close();
    await rename(temporary, file); await syncMomentDirectory(path.dirname(file));
  } finally { await fd.close(); await rm(temporary, { force: true }); }
}

export async function momentPathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
