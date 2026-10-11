import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "./taskClockProcess.js";
import { createHash } from "node:crypto";

import { cliChildEnvironment } from "../pi/cliEnvironment.js";
import { taskClockChildEnvironment } from "./taskClock.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { hasRefreshablePortableCredential, portableCredentialSecretValues } from "./portableCredentialAuth.js";

const MAX_AUTH_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 8 * 1024;

export type EngineReadiness = Readonly<{
  executablePath: string;
  engineHomePath: string;
  verify(): Promise<void>;
}>;

export type EngineExecutableReadiness = Readonly<{
  executablePath: string;
  verify(): Promise<void>;
}>;

type FileIdentity = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number; mode: number }>;

/**
 * Resolves and pins the small, local authority needed by one CLI engine. This
 * deliberately does not start an agent, contact a provider, or read a secret
 * beyond the bounded structural authentication check.
 */
export async function prepareEngineReadiness(
  agent: OrganizationRuntimeAgentConfig,
  runtimeHomePath: string,
  agyBusAddress?: string
): Promise<EngineReadiness> {
  const executable = await prepareEngineExecutable(agent.id, agent.engine.kind);
  const executablePath = executable.executablePath;
  const engineHomePath = agent.engine.kind === "agy" ? runtimeHomePath : path.join(runtimeHomePath, engineHomeName(agent.engine.kind));
  await verifyEngineAuth(agent.id, agent.engine.kind, engineHomePath, executablePath, runtimeHomePath, agyBusAddress);
  return {
    executablePath,
    engineHomePath,
    async verify(): Promise<void> {
      await executable.verify();
      await verifyEngineAuth(agent.id, agent.engine.kind, engineHomePath, executablePath, runtimeHomePath, agyBusAddress);
    }
  };
}

export async function prepareEngineExecutable(
  agentId: string,
  engine: "codex" | "grok" | "agy"
): Promise<EngineExecutableReadiness> {
  const executablePath = await resolveExecutable(agentId, engine);
  const executableIdentity = identity(await stat(executablePath));
  const capability = await probeExecutable(agentId, executablePath, engine);
  return {
    executablePath,
    async verify(): Promise<void> {
      let current: Awaited<ReturnType<typeof stat>>;
      try {
        const entry = await lstat(executablePath);
        if (entry.isSymbolicLink()) throw new Error("link");
        current = await stat(executablePath);
      } catch { throw unavailable(agentId, engine, "engine executable changed"); }
      if (!sameIdentity(executableIdentity, identity(current)) || !current.isFile()) {
        throw unavailable(agentId, engine, "engine executable changed");
      }
      if (await probeExecutable(agentId, executablePath, engine) !== capability) {
        throw unavailable(agentId, engine, "engine capability changed");
      }
    }
  };
}

export function engineHomeName(engine: "codex" | "grok"): string {
  return engine === "codex" ? ".codex" : ".grok";
}

export function engineAuthFile(_engine: "codex" | "grok", engineHomePath: string): string {
  return path.join(engineHomePath, "auth.json");
}

async function resolveExecutable(agentId: string, engine: "codex" | "grok" | "agy"): Promise<string> {
  const sourcePath = process.env.PATH ?? "";
  for (const directory of sourcePath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    try {
      const canonicalDirectory = await realpath(directory);
      const directoryEntry = await lstat(canonicalDirectory);
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() || (directoryEntry.mode & 0o022) !== 0) continue;
      const candidate = path.join(canonicalDirectory, engine);
      const entry = await lstat(candidate);
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const canonical = await realpath(candidate);
      const resolved = await lstat(canonical);
      if (!resolved.isFile() || resolved.isSymbolicLink() || (resolved.mode & 0o111) === 0) continue;
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw unavailable(agentId, engine, "engine executable cannot be inspected");
    }
  }
  throw unavailable(agentId, engine, "engine executable is unavailable");
}

async function probeExecutable(agentId: string, executablePath: string, engine: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executablePath, ["--version"], { cwd: path.dirname(executablePath), env: { PATH: process.env.PATH ?? path.dirname(executablePath), LANG: "C", LC_ALL: "C", ...taskClockChildEnvironment() }, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0;
    const output: Buffer[] = [];
    // Only stdout fingerprints the capability. stderr carries environment-dependent
    // diagnostics -- allocator warnings under emulation, for one -- which are not a
    // capability change but would otherwise invalidate the engine mid-run.
    const consume = (chunk: Buffer, capture: boolean): void => { bytes += chunk.length; if (bytes > MAX_PROBE_BYTES) child.kill("SIGKILL"); else if (capture) output.push(chunk); };
    child.stdout?.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => consume(chunk, false));
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    child.once("error", () => { clearTimeout(timer); reject(unavailable(agentId, engine, "engine capability probe failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && bytes <= MAX_PROBE_BYTES) resolve(createHash("sha256").update(Buffer.concat(output)).digest("hex"));
      else reject(unavailable(agentId, engine, "engine capability probe failed"));
    });
  });
}

async function verifyEngineAuth(
  agentId: string, engine: "codex" | "grok" | "agy", engineHomePath: string,
  executablePath: string, runtimeHomePath: string, agyBusAddress?: string
): Promise<void> {
  if (engine === "agy") {
    await verifyAgySubscriptionEnrollment(agentId, executablePath, runtimeHomePath, agyBusAddress);
    return;
  }
  await verifyPortableEngineAuth(agentId, engine, engineHomePath);
}

async function verifyPortableEngineAuth(agentId: string, engine: "codex" | "grok", engineHomePath: string): Promise<void> {
  const authPath = engineAuthFile(engine, engineHomePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    const home = await lstat(engineHomePath);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o777) !== 0o700) {
      throw new Error("unsafe engine home");
    }
    const entry = await lstat(authPath);
    assertPrivateAuthEntry(entry);
    handle = await open(authPath, constants.O_RDONLY | noFollow());
    const opened = await handle.stat();
    assertPrivateAuthEntry(opened);
    if (!sameIdentity(identity(entry), identity(opened))) throw new Error("auth artifact changed");
    buffer = await handle.readFile();
    const after = await handle.stat();
    assertPrivateAuthEntry(after);
    if (!sameIdentity(identity(opened), identity(after))) throw new Error("auth artifact changed");
    if (!hasRefreshablePortableCredential(engine, buffer)) throw new Error("unsupported auth artifact");
  } catch {
    throw unavailable(agentId, engine, "subscription authentication is not ready; provision the supported local credential and retry");
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

/** Securely rereads the currently staged provider credential for exact output redaction. */
export async function readPortableEngineCredentialSecrets(
  agentId: string,
  engine: "codex" | "grok",
  engineHomePath: string
): Promise<readonly string[]> {
  const authPath = engineAuthFile(engine, engineHomePath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    const home = await lstat(engineHomePath);
    if (!home.isDirectory() || home.isSymbolicLink() || home.uid !== process.getuid?.() || (home.mode & 0o777) !== 0o700) throw new Error("unsafe");
    const before = await lstat(authPath); assertPrivateAuthEntry(before);
    handle = await open(authPath, constants.O_RDONLY | noFollow());
    const opened = await handle.stat(); assertPrivateAuthEntry(opened);
    if (!sameIdentity(identity(before), identity(opened))) throw new Error("changed");
    buffer = await handle.readFile();
    const after = await handle.stat(); assertPrivateAuthEntry(after);
    if (!sameIdentity(identity(opened), identity(after)) || !hasRefreshablePortableCredential(engine, buffer)) throw new Error("changed");
    return portableCredentialSecretValues(engine, buffer);
  } catch {
    throw unavailable(agentId, engine, "subscription authentication is not ready");
  } finally {
    buffer?.fill(0);
    await handle?.close().catch(() => undefined);
  }
}

function assertPrivateAuthEntry(entry: Awaited<ReturnType<typeof lstat>>): void {
  if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.uid) !== process.getuid?.()
    || Number(entry.nlink) !== 1 || (Number(entry.mode) & 0o777) !== 0o600
    || Number(entry.size) < 1 || Number(entry.size) > MAX_AUTH_BYTES) {
    throw new Error("unsafe auth artifact");
  }
}

export async function verifyAgySubscriptionEnrollment(
  agentId: string,
  executablePath: string,
  runtimeHomePath: string,
  busAddress: string | undefined
): Promise<void> {
  if (busAddress === undefined) throw unavailable(agentId, "agy", "Daimon subscription realm is unavailable");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executablePath, ["models"], {
      cwd: runtimeHomePath,
      env: cliChildEnvironment([], runtimeHomePath, {
        dbusSessionBusAddress: busAddress,
        engine: "agy",
        executablePath,
        engineHomePath: runtimeHomePath
      }),
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("error", () => { clearTimeout(timer); reject(unavailable(agentId, "agy", "native secure-storage authentication probe failed")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(unavailable(agentId, "agy", "subscription enrollment is required; run the Daimon AGY bootstrap command"));
    });
  });
}
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function identity(value: Awaited<ReturnType<typeof stat>>): FileIdentity {
  const numeric = value as typeof value & { dev: number; ino: number; size: number; mtimeMs: number; mode: number };
  return { dev: numeric.dev, ino: numeric.ino, size: numeric.size, mtimeMs: numeric.mtimeMs, mode: numeric.mode & 0o7777 };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode; }
function unavailable(agentId: string, engine: string, detail: string): Error { return new Error(`agent ${agentId} ${engine} is unavailable: ${detail}`); }
