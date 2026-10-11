import { constants } from "node:fs";
import { spawn, type ChildProcess } from "./taskClockProcess.js";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { terminateChild, trackCliChild } from "../pi/cliProcess.js";
import { AGY_SUBSCRIPTION_REALM } from "./contractManifest.js";

const START_TIMEOUT_MS = 5_000;

export type AgySubscriptionRealm = Readonly<{
  busAddress: string;
  close(): Promise<void>;
}>;

export type AgySubscriptionRealmOptions = Readonly<{
  dbusDaemon?: string;
  durablePath?: string;
  flock?: string;
  gnomeKeyringDaemon?: string;
  shell?: string;
  socketReady?: (socketPath: string) => Promise<boolean>;
  temporaryRoot?: string;
  unlockSecretPath?: string;
}>;

type Identity = Readonly<{ dev: number; ino: number; mode: number; nlink: number; size: number; uid: number }>;
type NumericStats = Readonly<{
  dev: number | bigint; ino: number | bigint; mode: number | bigint; nlink: number | bigint;
  size: number | bigint; uid: number | bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>;

export const createAgyRealmCommands = (input: {
  busSocketPath: string;
  controlDirectory: string;
  dbusDaemon?: string;
  flock?: string;
  gnomeKeyringDaemon?: string;
  shell?: string;
}): Readonly<{
  bus: { command: string; args: string[] };
  keyring: { command: string; args: string[] };
  lease: { command: string; args: string[] };
}> => ({
  bus: {
    command: input.dbusDaemon ?? "dbus-daemon",
    args: ["--session", "--nofork", "--nopidfile", `--address=unix:path=${input.busSocketPath}`]
  },
  keyring: {
    command: input.gnomeKeyringDaemon ?? "gnome-keyring-daemon",
    args: ["--foreground", "--components=secrets", "--unlock", `--control-directory=${input.controlDirectory}`]
  },
  lease: {
    command: input.shell ?? "/bin/sh",
    args: [
      "-c",
      "\"$1\" --exclusive --nonblock --conflict-exit-code 73 3 || exit 73; printf 'ready\\n'; IFS= read -r _daimon_hold || :",
      "daimon-agy-lease",
      input.flock ?? "flock"
    ]
  }
});

export async function startAgySubscriptionRealm(
  options: AgySubscriptionRealmOptions = {}
): Promise<AgySubscriptionRealm> {
  const durablePath = options.durablePath ?? AGY_SUBSCRIPTION_REALM.durableMountPath;
  const unlockSecretPath = options.unlockSecretPath ?? AGY_SUBSCRIPTION_REALM.unlockMountPath;
  await verifyPrivateDirectory(durablePath);
  const unlockBytes = await readAgyRealmUnlockSecret(unlockSecretPath);
  const ephemeralPath = await mkdtemp(path.join(options.temporaryRoot ?? os.tmpdir(), "daimon-agy-realm-"));
  await chmod(ephemeralPath, 0o700);
  const busSocketPath = path.join(ephemeralPath, "bus");
  const controlDirectory = path.join(ephemeralPath, "keyring");
  await mkdir(controlDirectory, { mode: 0o700 });
  const commands = createAgyRealmCommands({
    busSocketPath,
    controlDirectory,
    dbusDaemon: options.dbusDaemon,
    flock: options.flock,
    gnomeKeyringDaemon: options.gnomeKeyringDaemon,
    shell: options.shell
  });
  const children: ChildProcess[] = [];
  let closePromise: Promise<void> | undefined;
  try {
    const lease = await acquireLease(durablePath, commands.lease);
    children.push(lease);
    const bus = ownedSpawn(commands.bus.command, commands.bus.args, realmEnvironment(durablePath, ephemeralPath), ["ignore", "ignore", "ignore"]);
    children.push(bus);
    await waitForSocket(busSocketPath, bus, options.socketReady);
    const busAddress = `unix:path=${busSocketPath}`;
    const environment = { ...realmEnvironment(durablePath, ephemeralPath), DBUS_SESSION_BUS_ADDRESS: busAddress };
    const keyring = ownedSpawn(commands.keyring.command, commands.keyring.args, environment, ["pipe", "ignore", "ignore"]);
    children.push(keyring);
    await deliverUnlockSecret(keyring, unlockBytes);
    await waitForSocket(path.join(controlDirectory, "control"), keyring, options.socketReady);

    const close = (): Promise<void> => closePromise ??= cleanup(children, ephemeralPath);
    return { busAddress, close };
  } catch (error) {
    try {
      await cleanup(children, ephemeralPath);
    } catch (cleanupError) {
      throw redactRealmFailure(new AggregateError([error, cleanupError], "AGY subscription realm startup cleanup failed"));
    }
    throw redactRealmFailure(error);
  } finally {
    unlockBytes.fill(0);
  }
}

export async function readAgyRealmUnlockSecret(sourcePath: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(sourcePath);
    assertUnlockIdentity(before);
    handle = await open(sourcePath, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    assertUnlockIdentity(opened);
    if (!sameIdentity(identity(before), identity(opened))) throw new Error("changed");
    const bytes = Buffer.alloc(Number(opened.size));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || bytes.includes(0) || bytes.includes(10) || bytes.includes(13)) {
      bytes.fill(0);
      throw new Error("invalid bytes");
    }
    return bytes;
  } catch {
    throw new Error("AGY subscription realm unlock secret is unavailable or unsafe");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyPrivateDirectory(directory: string): Promise<void> {
  try {
    const before = await lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== process.getuid?.()
      || (before.mode & 0o777) !== AGY_SUBSCRIPTION_REALM.directoryMode) throw new Error("unsafe");
    const canonical = await realpath(directory);
    if (canonical !== path.resolve(directory)) throw new Error("linked");
  } catch {
    throw new Error("AGY subscription realm durable state is unavailable or unsafe");
  }
}

async function acquireLease(
  durablePath: string,
  command: { command: string; args: string[] }
): Promise<ChildProcess> {
  const lockPath = path.join(durablePath, ".daimon-lease");
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lock = await open(lockPath, constants.O_CREAT | constants.O_RDWR | noFollow(), 0o600);
    const entry = await lock.stat();
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.()
      || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600) throw new Error("unsafe lease");
    const child = ownedSpawn(command.command, command.args, leaseEnvironment(), ["pipe", "pipe", "ignore", lock.fd]);
    try {
      await waitForReady(child);
      return child;
    } catch (error) {
      try { await terminateChild(child); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "lease acquisition cleanup failed");
      }
      throw error;
    }
  } catch {
    throw new Error("AGY subscription realm is already in use or cannot be leased");
  } finally {
    await lock?.close().catch(() => undefined);
  }
}

async function deliverUnlockSecret(keyring: ChildProcess, secret: Buffer): Promise<void> {
  if (keyring.stdin === null) throw new Error("keyring input is unavailable");
  await new Promise<void>((resolve, reject) => {
    const fail = (): void => reject(new Error("keyring stopped before unlock"));
    keyring.once("close", fail);
    keyring.once("error", fail);
    keyring.stdin!.once("error", fail);
    keyring.stdin!.end(secret, () => {
      keyring.off("close", fail);
      keyring.off("error", fail);
      keyring.stdin!.off("error", fail);
      resolve();
    });
  });
}

function ownedSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdio: Parameters<typeof spawn>[2] extends infer _Options ? Array<"ignore" | "pipe" | number> : never
): ChildProcess {
  return trackCliChild(spawn(command, args, {
    detached: process.platform !== "win32",
    env,
    stdio
  }));
}

async function waitForSocket(
  socketPath: string,
  child: ChildProcess,
  socketReady?: (socketPath: string) => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("bus stopped");
    try {
      if (socketReady ? await socketReady(socketPath) : await defaultSocketReady(socketPath)) return;
    } catch { /* not ready */ }
    await delay(20);
  }
  throw new Error("bus startup timed out");
}

async function defaultSocketReady(socketPath: string): Promise<boolean> {
  const entry = await lstat(socketPath);
  return entry.isSocket() && entry.uid === process.getuid?.();
}

function waitForReady(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lease startup timed out")), START_TIMEOUT_MS);
    child.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timer);
      if (chunk.toString("utf8") === "ready\n") resolve(); else reject(new Error("lease response invalid"));
    });
    child.once("close", () => { clearTimeout(timer); reject(new Error("lease rejected")); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("lease failed")); });
  });
}

async function cleanup(children: ChildProcess[], ephemeralPath: string): Promise<void> {
  const failures: unknown[] = [];
  for (const child of [...children].reverse()) {
    child.stdin?.end();
    try { await terminateChild(child); } catch (error) { failures.push(error); }
  }
  try { await rm(ephemeralPath, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, "AGY subscription realm cleanup failed");
}

const realmEnvironment = (durablePath: string, ephemeralPath: string): NodeJS.ProcessEnv => ({
  HOME: durablePath,
  LANG: "C",
  LC_ALL: "C",
  PATH: process.env.PATH,
  XDG_DATA_HOME: durablePath,
  XDG_RUNTIME_DIR: ephemeralPath
});
const leaseEnvironment = (): NodeJS.ProcessEnv => ({ LANG: "C", LC_ALL: "C", PATH: process.env.PATH });
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const noFollow = (): number => (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const identity = (value: NumericStats): Identity => ({ dev: Number(value.dev), ino: Number(value.ino), mode: Number(value.mode) & 0o7777, nlink: Number(value.nlink), size: Number(value.size), uid: Number(value.uid) });
const sameIdentity = (left: Identity, right: Identity): boolean => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.uid === right.uid;
const assertUnlockIdentity = (entry: NumericStats): void => {
  const value = identity(entry);
  if (!entry.isFile() || entry.isSymbolicLink() || value.uid !== process.getuid?.() || value.nlink !== 1
    || (value.mode & 0o777) !== AGY_SUBSCRIPTION_REALM.fileMode || value.size < 1 || value.size > AGY_SUBSCRIPTION_REALM.maxUnlockBytes) throw new Error("unsafe");
};
const redactRealmFailure = (error: unknown): Error => error instanceof Error && /^AGY subscription realm/u.test(error.message)
  ? error
  : new Error("AGY subscription realm could not be started", { cause: error });
