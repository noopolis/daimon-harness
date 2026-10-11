import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { spawn, type ChildProcess } from "./taskClockProcess.js";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { terminateChild, trackCliChild } from "../pi/cliProcess.js";
import { GROK_SUBSCRIPTION_REALM } from "./contractManifest.js";
import { hasRefreshablePortableCredential } from "./portableCredentialAuth.js";
import { asGrokAuthenticationRejected } from "./grokAuthenticationError.js";
import type {
  GrokAgent,
  GrokCredentialJournal as Journal,
  GrokSubscriptionRealm,
  GrokSubscriptionRealmOptions
} from "./grokSubscriptionRealmTypes.js";
export type { GrokSubscriptionRealm, GrokSubscriptionRealmOptions } from "./grokSubscriptionRealmTypes.js";
const AUTH_FILE = "auth.json";
const JOURNAL_FILE = "lease.json";
const STALE_FILE = "stale.json";
const BOOTSTRAP_FILE = "bootstrap.json";
const LEASE_FILE = ".daimon-lease";
const MAX_CONTROL_BYTES = 4_096;
export async function startGrokSubscriptionRealm(
  configuredAgents: readonly GrokAgent[],
  options: GrokSubscriptionRealmOptions = {}
): Promise<GrokSubscriptionRealm> {
  const durablePath = options.durablePath ?? GROK_SUBSCRIPTION_REALM.durableMountPath;
  const bootstrapPath = options.bootstrapPath ?? GROK_SUBSCRIPTION_REALM.bootstrapMountPath;
  await verifyPrivateDirectory(durablePath);
  const lease = await acquireRealmLease(durablePath, options);
  const agents = new Map(configuredAgents.map((agent) => [agent.id, agent]));
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let bootstrapDigest: string;
  try {
    bootstrapDigest = await initializeRealm(durablePath, bootstrapPath, agents);
  } catch (error) {
    await terminateChild(lease).catch(() => undefined);
    throw redact(error);
  }
  const withCredential = async <T>(agent: GrokAgent, operation: () => Promise<T>): Promise<T> => {
    if (closed || agents.get(agent.id)?.runtimeHomePath !== agent.runtimeHomePath) throw redact();
    let release!: () => void;
    const prior = tail;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      if (closed) throw redact();
      return await runLeasedTurn(durablePath, bootstrapDigest, agent, operation, options.onTransitionForTest);
    } finally {
      release();
    }
  };
  return {
    withCredential,
    close: () => closePromise ??= (async () => {
      closed = true;
      await tail;
      await terminateChild(lease);
    })()
  };
}

async function initializeRealm(
  durablePath: string,
  bootstrapPath: string,
  agents: ReadonlyMap<string, GrokAgent>
): Promise<string> {
  const bootstrap = await readCredential(bootstrapPath);
  try {
    const observedBootstrap = await readBootstrap(path.join(durablePath, BOOTSTRAP_FILE));
    const journal = await readJournal(path.join(durablePath, JOURNAL_FILE));
    if (journal !== undefined) {
      await recoverJournal(
        durablePath,
        journal,
        agents,
        observedBootstrap?.bootstrap_digest ?? bootstrap.digest
      );
    }
    const stale = await readStale(path.join(durablePath, STALE_FILE));
    const authority = await readOptionalAuthority(path.join(durablePath, AUTH_FILE));
    const shouldImport = stale !== undefined
      ? stale.bootstrap_digest !== bootstrap.digest
      : authority === undefined || (observedBootstrap !== undefined
        && observedBootstrap.bootstrap_digest !== bootstrap.digest);
    authority?.bytes.fill(0);
    if (shouldImport) {
      await atomicCredentialWrite(path.join(durablePath, AUTH_FILE), bootstrap.bytes);
      await unlink(path.join(durablePath, STALE_FILE)).catch(ignoreMissing);
      await syncDirectory(durablePath);
    }
    if (shouldImport || observedBootstrap === undefined) {
      await writeBootstrap(path.join(durablePath, BOOTSTRAP_FILE), bootstrap.digest);
    }
    if (await readStale(path.join(durablePath, STALE_FILE)) !== undefined) throw redact();
    return bootstrap.digest;
  } finally {
    bootstrap.bytes.fill(0);
  }
}

async function runLeasedTurn<T>(
  durablePath: string,
  bootstrapDigest: string,
  agent: GrokAgent,
  operation: () => Promise<T>,
  onTransition?: GrokSubscriptionRealmOptions["onTransitionForTest"]
): Promise<T> {
  if (await readStale(path.join(durablePath, STALE_FILE)) !== undefined) throw redact();
  await verifyPrivateDirectory(path.dirname(path.join(
    agent.runtimeHomePath,
    GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath
  )));
  const target = path.join(agent.runtimeHomePath, GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath);
  await assertAbsent(target);
  const authority = await readCredential(path.join(durablePath, AUTH_FILE));
  const journalPath = path.join(durablePath, JOURNAL_FILE);
  try {
    await writeJournal(journalPath, { agent_id: agent.id, source_digest: authority.digest, state: "preparing", version: "noopolis.daimon.grok-credential-lease.v1" });
    await atomicCredentialWrite(target, authority.bytes);
    await writeJournal(journalPath, { agent_id: agent.id, source_digest: authority.digest, state: "active", version: "noopolis.daimon.grok-credential-lease.v1" });
  } finally {
    authority.bytes.fill(0);
  }
  let result: T | undefined;
  let operationError: unknown;
  try { result = await operation(); } catch (error) { operationError = error; }
  if (asGrokAuthenticationRejected(operationError) !== undefined) {
    await unlink(target).catch(ignoreMissing);
    await syncDirectory(path.dirname(target));
    await markStale(durablePath, bootstrapDigest);
    throw redact();
  }
  const candidate = await tryReadCredential(target);
  if (candidate === undefined) {
    await unlink(target).catch(ignoreMissing);
    await syncDirectory(path.dirname(target));
    await markStale(durablePath, bootstrapDigest);
    throw redact(operationError);
  }
  try {
    await writeJournal(journalPath, {
      agent_id: agent.id,
      promoted_digest: candidate.digest,
      source_digest: authority.digest,
      state: "promoting",
      version: "noopolis.daimon.grok-credential-lease.v1"
    });
    await onTransition?.("promotion_prepared");
    await atomicCredentialWrite(path.join(durablePath, AUTH_FILE), candidate.bytes);
    await onTransition?.("authority_replaced");
    await writeJournal(journalPath, {
      agent_id: agent.id,
      promoted_digest: candidate.digest,
      source_digest: authority.digest,
      state: "promoted",
      version: "noopolis.daimon.grok-credential-lease.v1"
    });
    await unlink(target).catch(ignoreMissing);
    await syncDirectory(path.dirname(target));
    await unlink(journalPath).catch(ignoreMissing);
    await syncDirectory(durablePath);
  } finally {
    candidate.bytes.fill(0);
  }
  if (operationError !== undefined) throw operationError;
  return result as T;
}

async function recoverJournal(
  durablePath: string,
  journal: Journal,
  agents: ReadonlyMap<string, GrokAgent>,
  bootstrapDigest: string
): Promise<void> {
  const agent = agents.get(journal.agent_id);
  const target = agent === undefined ? undefined
    : path.join(agent.runtimeHomePath, GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath);
  if (target !== undefined) await verifyPrivateDirectory(path.dirname(target));
  const authority = await readCredential(path.join(durablePath, AUTH_FILE));
  const authorityDigest = authority.digest;
  try {
    const expected = journal.state === "promoted" ? [journal.promoted_digest]
      : journal.state === "promoting" ? [journal.source_digest, journal.promoted_digest]
        : [journal.source_digest];
    if (!expected.includes(authorityDigest)) {
      if (target !== undefined) { await unlink(target).catch(ignoreMissing); await syncDirectory(path.dirname(target)); }
      await markStale(durablePath, bootstrapDigest);
      return;
    }
  } finally { authority.bytes.fill(0); }
  if (journal.state === "promoted") {
    if (target !== undefined) {
      await unlink(target).catch(ignoreMissing);
      await syncDirectory(path.dirname(target));
    }
    await unlink(path.join(durablePath, JOURNAL_FILE)).catch(ignoreMissing);
    await syncDirectory(durablePath);
    return;
  }
  if (journal.state === "preparing") {
    if (target !== undefined) await unlink(target).catch(ignoreMissing);
    await unlink(path.join(durablePath, JOURNAL_FILE)).catch(ignoreMissing);
    await syncDirectory(durablePath);
    return;
  }
  const candidate = target === undefined ? undefined : await tryReadCredential(target);
  if (candidate === undefined) {
    if (target !== undefined) {
      await unlink(target).catch(ignoreMissing);
      await syncDirectory(path.dirname(target));
    }
    await markStale(durablePath, bootstrapDigest);
    return;
  }
  try {
    if (journal.state === "promoting" && candidate.digest !== journal.promoted_digest) {
      await markStale(durablePath, bootstrapDigest);
      return;
    }
    if (journal.state === "active") await writeJournal(path.join(durablePath, JOURNAL_FILE), { ...journal, promoted_digest: candidate.digest, state: "promoting" });
    if (authorityDigest === journal.source_digest) {
      await atomicCredentialWrite(path.join(durablePath, AUTH_FILE), candidate.bytes);
    }
    await writeJournal(path.join(durablePath, JOURNAL_FILE), {
      ...journal, promoted_digest: candidate.digest, state: "promoted"
    });
    await unlink(target!).catch(ignoreMissing);
    await syncDirectory(path.dirname(target!));
    await unlink(path.join(durablePath, JOURNAL_FILE)).catch(ignoreMissing);
    await syncDirectory(durablePath);
  } finally {
    candidate.bytes.fill(0);
  }
}

async function markStale(durablePath: string, bootstrapDigest: string): Promise<void> {
  await atomicJsonWrite(path.join(durablePath, STALE_FILE), {
    bootstrap_digest: bootstrapDigest,
    version: "noopolis.daimon.grok-credential-stale.v1"
  });
  await unlink(path.join(durablePath, JOURNAL_FILE)).catch(ignoreMissing);
  await syncDirectory(durablePath);
}

async function readCredential(file: string): Promise<{ bytes: Buffer; digest: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(file);
    assertCredentialIdentity(before);
    handle = await open(file, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    assertCredentialIdentity(opened);
    if (!sameIdentity(before, opened)) throw new Error("changed");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after) || !hasRefreshablePortableCredential("grok", bytes)) {
      bytes.fill(0); throw new Error("invalid");
    }
    return { bytes, digest: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw redact();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
async function tryReadCredential(file: string): Promise<Awaited<ReturnType<typeof readCredential>> | undefined> {
  try { return await readCredential(file); } catch { return undefined; }
}
async function readOptionalAuthority(file: string): Promise<Awaited<ReturnType<typeof readCredential>> | undefined> {
  try {
    return await readCredential(file);
  } catch {
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    }
    throw redact();
  }
}
async function atomicCredentialWrite(file: string, bytes: Uint8Array): Promise<void> {
  await atomicWrite(file, bytes, GROK_SUBSCRIPTION_REALM.fileMode);
  const checked = await readCredential(file);
  checked.bytes.fill(0);
}
async function atomicJsonWrite(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, Buffer.from(`${JSON.stringify(value)}\n`), 0o600);
}
async function atomicWrite(file: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), mode);
    await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, file); await syncDirectory(path.dirname(file));
  } catch { throw redact(); } finally {
    await handle?.close().catch(() => undefined); await unlink(temporary).catch(() => undefined);
  }
}
async function writeJournal(file: string, value: Journal): Promise<void> { await atomicJsonWrite(file, value); }
async function readJournal(file: string): Promise<Journal | undefined> {
  return readPrivateJson(file, (value) => {
    const candidate = value as Partial<Journal>;
    if (candidate.version !== "noopolis.daimon.grok-credential-lease.v1" || !["active", "preparing", "promoted", "promoting"].includes(candidate.state ?? "")
      || typeof candidate.agent_id !== "string" || !candidate.agent_id || !/^[a-f0-9]{64}$/u.test(candidate.source_digest ?? "")
      || (["promoted", "promoting"].includes(candidate.state ?? "") && !/^[a-f0-9]{64}$/u.test(candidate.promoted_digest ?? ""))) throw new Error("invalid");
    return candidate as Journal;
  });
}
async function readStale(file: string): Promise<{ bootstrap_digest: string } | undefined> {
  return readPrivateJson(file, (value) => {
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== "noopolis.daimon.grok-credential-stale.v1" || typeof candidate.bootstrap_digest !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.bootstrap_digest)) throw new Error("invalid");
    return { bootstrap_digest: candidate.bootstrap_digest };
  });
}
async function readBootstrap(file: string): Promise<{ bootstrap_digest: string } | undefined> {
  return readPrivateJson(file, (value) => {
    const candidate = value as Record<string, unknown>;
    if (candidate.version !== "noopolis.daimon.grok-bootstrap-observation.v1" || typeof candidate.bootstrap_digest !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.bootstrap_digest)) throw new Error("invalid");
    return { bootstrap_digest: candidate.bootstrap_digest };
  });
}
async function writeBootstrap(file: string, bootstrapDigest: string): Promise<void> {
  await atomicJsonWrite(file, {
    bootstrap_digest: bootstrapDigest,
    version: "noopolis.daimon.grok-bootstrap-observation.v1"
  });
}
async function readPrivateJson<T>(file: string, parse: (value: unknown) => T): Promise<T | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    const before = await lstat(file);
    assertPrivateFileIdentity(before, MAX_CONTROL_BYTES);
    handle = await open(file, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    assertPrivateFileIdentity(opened, MAX_CONTROL_BYTES);
    if (!sameIdentity(before, opened)) throw new Error("changed");
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameIdentity(opened, after)) throw new Error("changed");
    return parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw redact();
  } finally {
    bytes?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}
async function verifyPrivateDirectory(directory: string): Promise<void> {
  try { const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== GROK_SUBSCRIPTION_REALM.directoryMode) throw new Error("unsafe"); }
  catch { throw redact(); }
}

async function assertAbsent(file: string): Promise<void> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw redact();
}

async function acquireRealmLease(durablePath: string, options: GrokSubscriptionRealmOptions): Promise<ChildProcess> {
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let child: ChildProcess | undefined;
  try {
    lock = await open(path.join(durablePath, LEASE_FILE), constants.O_CREAT | constants.O_RDWR | noFollow(), 0o600);
    const entry = await lock.stat();
    if (!entry.isFile() || entry.uid !== process.getuid?.() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600) throw new Error("unsafe");
    child = trackCliChild(spawn(options.shell ?? "/bin/sh", ["-c", "\"$1\" --exclusive --nonblock --conflict-exit-code 73 3 || exit 73; printf 'ready\\n'; IFS= read -r _hold || :", "daimon-grok-lease", options.flock ?? "flock"], { detached: process.platform !== "win32", env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore", lock.fd] }));
    await waitForReady(child); return child;
  } catch {
    if (child !== undefined) await terminateChild(child).catch(() => undefined);
    throw redact();
  } finally { await lock?.close().catch(() => undefined); }
}

async function waitForReady(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 5_000);
    child.stdout?.once("data", (value: Buffer) => { clearTimeout(timer); value.toString("utf8") === "ready\n" ? resolve() : reject(new Error("invalid")); });
    child.once("close", () => { clearTimeout(timer); reject(new Error("closed")); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("failed")); });
  });
}

async function syncDirectory(directory: string): Promise<void> { const handle = await open(directory, constants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
const ignoreMissing = (error: unknown): void => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; };
const noFollow = (): number => (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const sameIdentity = (left: Awaited<ReturnType<typeof lstat>>, right: Awaited<ReturnType<typeof lstat>>): boolean => left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.uid === right.uid && left.mtimeMs === right.mtimeMs;
const assertCredentialIdentity = (entry: Awaited<ReturnType<typeof lstat>>): void => { if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.() || Number(entry.nlink) !== 1 || (Number(entry.mode) & 0o777) !== GROK_SUBSCRIPTION_REALM.fileMode || Number(entry.size) < 1 || Number(entry.size) > GROK_SUBSCRIPTION_REALM.maxCredentialBytes) throw new Error("unsafe"); };
const assertPrivateFileIdentity = (entry: Awaited<ReturnType<typeof lstat>>, maxBytes: number): void => { if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.() || Number(entry.nlink) !== 1 || (Number(entry.mode) & 0o777) !== 0o600 || Number(entry.size) < 1 || Number(entry.size) > maxBytes) throw new Error("unsafe"); };
const redact = (_cause?: unknown): Error => new Error("Grok subscription credential realm is unavailable or stale");
