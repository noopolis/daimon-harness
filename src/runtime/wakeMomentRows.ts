import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { openMomentFile, syncMomentDirectory, WakeMomentFault } from "./wakeMomentFs.js";
import { WakeMomentIo } from "./wakeMomentIo.js";
import type { WakeMomentRow } from "./wakeMomentRecorder.js";

/** One append write and fsync. A torn prior append is delimited, never mistaken for this attempt. */
export async function appendWakeMomentRow(directory: string, row: WakeMomentRow, io = new WakeMomentIo()): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(row)}\n`);
  if (line.length > WAKE_MOMENTS.maxRowBytes) throw new WakeMomentFault("row_size_limit");
  const target = path.join(directory, WAKE_MOMENTS.rowsFile);
  let created = false, fd: FileHandle;
  try { fd = await openMomentFile(target, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND, io); created = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = await openMomentFile(target, constants.O_RDWR | constants.O_APPEND, io);
  }
  try {
    const size = (await fd.stat()).size;
    const tail = Buffer.alloc(1);
    if (size) await fd.read(tail, 0, 1, size - 1);
    const bytes = size && tail[0] !== 10 ? Buffer.concat([Buffer.from("\n"), line]) : line;
    const { bytesWritten } = await fd.write(bytes);
    if (bytesWritten !== bytes.length) throw new WakeMomentFault("short_row_write");
    await fd.sync();
    if (created) await syncMomentDirectory(directory, io);
  } finally { await fd.close(); }
}

/** Bound memory even when a damaged/foreign rows file has no newlines. */
export async function* momentLines(fd: FileHandle): AsyncGenerator<Buffer> {
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

