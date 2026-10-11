import { randomUUID } from "node:crypto";
import { spawnRealTime as spawn } from "../runtime/taskClockProcess.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { readChild } from "./cliChildOutput.js";
import { cliChildEnvironment } from "./cliEnvironment.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";
import { renderGrokSandboxArgs } from "./cliEngineSpawn.js";
import { assertGrokWorkerDenyPathsPlaceable } from "../runtime/grokWorkerDenyPlacement.js";
import { GROK_WORKER_SANDBOX_EVENTS_RELATIVE_PATH, GROK_WORKER_SANDBOX_PROFILE, renderGrokWorkerSandboxProfile } from "../runtime/grokWorkerSandboxProfile.js";

export const GROK_DAIMON_SANDBOX_PROFILE = GROK_WORKER_SANDBOX_PROFILE;
const SANDBOX_CONFIG = "sandbox.toml";
/** Grok 1.0.34 logs sandbox events under `sessions/`; the root file stays empty. */
const SANDBOX_EVENTS = GROK_WORKER_SANDBOX_EVENTS_RELATIVE_PATH;
const MAX_EVENTS_BYTES = 16 * 1024 * 1024;
const ROTATE_EVENTS_BYTES = 8 * 1024 * 1024;

export interface GrokSandboxAuthority {
  readonly command: string;
  readonly commandArgs?: readonly string[];
  readonly cwd: string;
  readonly engineHomePath: string;
  readonly protectedPaths: readonly string[];
  readonly runtimeHomePath: string;
}

export async function prepareAndVerifyGrokSandbox(
  authority: GrokSandboxAuthority
): Promise<void> {
  const engineHome = await realpath(authority.engineHomePath);
  const cwd = await realpath(authority.cwd);
  await assertPrivateDirectory(engineHome);
  const denied = [...new Set(await Promise.all(authority.protectedPaths.map((entry) => realpath(entry))))].sort();
  if (denied.some((entry) => overlaps(entry, cwd) || overlaps(entry, engineHome))) {
    throw unavailable();
  }
  // Grok 1.0.34 materializes every deny target inside bubblewrap as the uid it
  // runs Grok under — here, this process's own — and refuses the whole profile
  // if one cannot be resolved. Refusing now names the path; letting it through
  // would kill every turn with a bare `bwrap: Can't create file at …`.
  await assertGrokWorkerDenyPathsPlaceable(denied, { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
  await writeProfile(engineHome, denied);
  const beforeBytes = await eventFileSize(path.join(engineHome, SANDBOX_EVENTS));
  const child = trackCliChild(spawn(authority.command, [
    ...renderGrokSandboxArgs(authority.commandArgs, GROK_DAIMON_SANDBOX_PROFILE),
    "--cwd", cwd,
    "inspect"
  ], {
    cwd,
    detached: process.platform !== "win32",
    env: cliChildEnvironment([], authority.runtimeHomePath, {
      engine: "grok",
      engineHomePath: engineHome,
      executablePath: authority.command
    }),
    stdio: ["ignore", "pipe", "pipe"]
  }));
  try {
    await readChild(child, 10_000, []);
  } catch {
    throw unavailable();
  } finally {
    await terminateChild(child).catch(() => undefined);
  }
  await verifyEnforcementEvent(path.join(engineHome, SANDBOX_EVENTS), beforeBytes, cwd, denied);
  await verifyProfile(engineHome, denied);
}

const profileText = (denied: readonly string[]): string => renderGrokWorkerSandboxProfile(denied);

async function writeProfile(engineHome: string, denied: readonly string[]): Promise<void> {
  const target = path.join(engineHome, SANDBOX_CONFIG);
  const temporary = path.join(engineHome, `.${SANDBOX_CONFIG}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
    await handle.writeFile(profileText(denied));
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(engineHome);
    await verifyProfile(engineHome, denied);
  } catch {
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function verifyProfile(engineHome: string, denied: readonly string[]): Promise<void> {
  const file = path.join(engineHome, SANDBOX_CONFIG);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    assertPrivateFile(before, 64 * 1024);
    handle = await open(file, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    assertPrivateFile(opened, 64 * 1024);
    if (!sameIdentity(before, opened) || await handle.readFile("utf8") !== profileText(denied)) throw new Error("changed");
    const after = await handle.stat();
    if (!sameIdentity(opened, after)) throw new Error("changed");
  } catch {
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyEnforcementEvent(
  file: string,
  beforeBytes: number,
  cwd: string,
  denied: readonly string[]
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    assertPrivateFile(before, MAX_EVENTS_BYTES);
    if (before.size <= beforeBytes) throw new Error("missing event");
    handle = await open(file, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    if (!sameIdentity(before, opened)) throw new Error("changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after)) throw new Error("changed");
    const appended = bytes.subarray(beforeBytes).toString("utf8").trim().split("\n").filter(Boolean);
    const event = JSON.parse(appended.at(-1) ?? "null") as Record<string, unknown> | null;
    const observedDenied = Array.isArray(event?.deny_paths)
      ? event.deny_paths.filter((entry): entry is string => typeof entry === "string").sort()
      : [];
    if (event?.event_type !== "ProfileApplied" || event.profile !== GROK_DAIMON_SANDBOX_PROFILE
      || event.enforced !== true || event.restrict_network !== true || event.workspace !== cwd
      || !/^(?:linux\/landlock|macos\/seatbelt)$/u.test(String(event.platform ?? ""))
      || JSON.stringify(observedDenied) !== JSON.stringify(denied)) throw new Error("not enforced");
    bytes.fill(0);
  } catch {
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function eventFileSize(file: string): Promise<number> {
  try {
    const entry = await lstat(file);
    assertPrivateFile(entry, MAX_EVENTS_BYTES, true);
    if (entry.size >= ROTATE_EVENTS_BYTES) {
      await replaceWithEmptyPrivateFile(file);
      return 0;
    }
    return Number(entry.size);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(path.dirname(file));
      return 0;
    }
    throw unavailable();
  }
}

async function replaceWithEmptyPrivateFile(file: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
    const entry = await lstat(file);
    assertPrivateFile(entry, 0, true);
  } catch {
    throw unavailable();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  try {
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || (Number(entry.mode) & 0o777) !== 0o700) throw new Error("unsafe");
  } catch { throw unavailable(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
const overlaps = (left: string, right: string): boolean =>
  left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
const sameIdentity = (left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.nlink === right.nlink && left.size === right.size && left.uid === right.uid && left.mtimeMs === right.mtimeMs;
const assertPrivateFile = (entry: Awaited<ReturnType<typeof lstat>>, maxBytes: number, allowEmpty = false): void => {
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
    || entry.nlink !== 1 || (Number(entry.mode) & 0o777) !== 0o600
    || (!allowEmpty && entry.size < 1) || entry.size > maxBytes) throw new Error("unsafe");
};
const noFollow = (): number => (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const unavailable = (): Error => new Error("Grok kernel sandbox enforcement is unavailable");
