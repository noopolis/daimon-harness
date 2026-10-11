import { createHash } from "node:crypto";
import path from "node:path";
import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import { readMomentJson, writeMomentJson } from "./wakeMomentFs.js";
import { WakeMomentIo } from "./wakeMomentIo.js";

export const SNAPSHOT_NAME = /^\d{8}T\d{9}Z-[A-Za-z0-9._-]{1,200}$/;
export const snapshotRootName = (id: string): string => id === "." || id === ".." ? id.replaceAll(".", "%2E") : id;
const INDEX_VERSION = "noopolis.daimon.wake-latest.v1";
const INDEX_BYTES = 1024;
export type SnapshotIndex = { version: typeof INDEX_VERSION; snapshot: string; oldest: string | null };

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

/** Eligibility precedes BOTH base selection and retention protection, not only deletion. */
export async function eligibleSnapshot(directory: string, name: string, io: WakeMomentIo): Promise<boolean> {
  if (!Number.isFinite(snapshotTime(name))) return false;
  try {
    const target = path.join(directory, name);
    const entry = await io.fs.lstat(target), manifest = await io.fs.lstat(`${target}.manifest.json`);
    const marker = await io.fs.lstat(`${target}${WAKE_MOMENTS.completionSuffix}`);
    return entry.isDirectory() && manifest.isFile() && manifest.nlink === 1
      && marker.isFile() && marker.size === 0 && marker.nlink === 1;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Only a missing/invalid index or an expired oldest name requires history enumeration. */
export async function completeSnapshotNames(directory: string, io = new WakeMomentIo()): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of await io.fs.opendir(directory)) {
      if (entry.isDirectory() && await eligibleSnapshot(directory, entry.name, io)) names.push(entry.name);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  names.sort((a, b) => snapshotTime(b) - snapshotTime(a) || b.localeCompare(a));
  // Timestamp ties use publication metadata; no historical manifest contents are read.
  const stamps = new Map<string, bigint>();
  for (let i = 0; i < names.length; i++) if (snapshotTime(names[i]!) === snapshotTime(names[i - 1] ?? "") || snapshotTime(names[i]!) === snapshotTime(names[i + 1] ?? "")) {
    stamps.set(names[i]!, (await io.fs.lstat(path.join(directory, `${names[i]}.manifest.json`), { bigint: true })).mtimeNs);
  }
  return names.sort((a, b) => snapshotTime(b) - snapshotTime(a) || ((stamps.get(a) ?? 0n) < (stamps.get(b) ?? 0n) ? 1 : (stamps.get(a) ?? 0n) > (stamps.get(b) ?? 0n) ? -1 : b.localeCompare(a)));
}

export function indexFromNames(names: string[]): SnapshotIndex | undefined {
  return names[0] ? { version: INDEX_VERSION, snapshot: names[0], oldest: names.length > 1 ? names[names.length - 1]! : null } : undefined;
}

export async function latestSnapshotIndex(directory: string, io: WakeMomentIo): Promise<{ index?: SnapshotIndex; names?: string[] }> {
  try {
    const value = await readMomentJson(path.join(directory, "latest"), io, INDEX_BYTES) as SnapshotIndex;
    if (value?.version === INDEX_VERSION && typeof value.snapshot === "string"
      && (value.oldest === null || (typeof value.oldest === "string" && value.oldest !== value.snapshot
        && Number.isFinite(snapshotTime(value.oldest)) && snapshotTime(value.oldest) <= snapshotTime(value.snapshot)))
      && await eligibleSnapshot(directory, value.snapshot, io)) return { index: value };
  } catch { io.check(); /* The bounded index is a cache; recover from missing/damaged metadata. */ }
  const names = await completeSnapshotNames(directory, io);
  return { index: indexFromNames(names), names };
}

/** Called after manifest publication, before the marker: a crash leaves an invalid index,
 * never a valid stale pointer hiding a newer complete snapshot. Clock rollback keeps the newer base. */
export function indexWithSnapshot(previous: SnapshotIndex | undefined, name: string): SnapshotIndex {
  if (!previous) return { version: INDEX_VERSION, snapshot: name, oldest: null };
  const newest = snapshotTime(name) >= snapshotTime(previous.snapshot) ? name : previous.snapshot;
  const others = [previous.oldest, newest === name ? previous.snapshot : name].filter((entry): entry is string => entry !== null);
  others.sort((a, b) => snapshotTime(a) - snapshotTime(b));
  return { version: INDEX_VERSION, snapshot: newest, oldest: others[0]! };
}

export async function writeSnapshotIndex(directory: string, index: SnapshotIndex, io: WakeMomentIo, cleanup: Set<string>): Promise<void> {
  const target = path.join(directory, "latest");
  await writeMomentJson(target, JSON.stringify(index), io, cleanup, true);
  cleanup.delete(target);
}
