import { constants, type Stats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import { pathsOverlap } from "./organizationRuntimeRecording.js";

type Identity = Readonly<{ dev: number; ino: number; uid: number; mode: number }>;
/**
 * `private` is every engine's runtime home: 0700, nothing but the runtime user.
 *
 * `worker-traversable` is the brokered Grok shape, and only that shape: the
 * agent's own sandboxed worker runs as another uid and must be able to *walk
 * into* this home to read the setgid `tool-output/` spill directory the
 * truncation notice sends it to (`GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome`).
 * Traverse-only means `0710`: no group read (the worker cannot list the home or
 * see the acceptance store, telemetry, memory or credential names) and no group
 * write. Anything wider — `0711`, `0750`, `0770`, any world bit — is refused,
 * as is a group that is not a worker group. Daimon cannot tell *which* worker
 * gid belongs to this agent; the per-slot mapping is the deployment's
 * provisioning contract, re-checked by the slot preflight receipt's worker-uid
 * canaries.
 */
type DirectoryShape = "safe" | "private" | "worker-traversable";
type Directory = { readonly configured: string; readonly real: string; readonly fd: Awaited<ReturnType<typeof open>>; readonly identity: Identity; closed: boolean };

/**
 * Holds identities for caller-created roots. Daimon neither creates nor rolls
 * back these directories: the deployer owns their lifecycle and contents.
 */
export type OrganizationRuntimePathAuthority = Readonly<{
  forAgent(agent: OrganizationRuntimeAgentConfig): Readonly<{
    workspacePath: string;
    runtimeHomePath: string;
    verify(): Promise<void>;
  }>;
  close(): Promise<void>;
}>;

/** Only a brokered Grok agent's home is worker-traversable; every other engine keeps 0700. */
function runtimeHomeShape(agent: OrganizationRuntimeAgentConfig): DirectoryShape {
  return agent.engine.kind === "grok" ? "worker-traversable" : "private";
}

export async function prepareOrganizationRuntimePaths(
  agents: readonly OrganizationRuntimeAgentConfig[]
): Promise<OrganizationRuntimePathAuthority> {
  const workspaces = new Map<string, Directory>();
  const homes = new Map<string, Directory>();
  const recordings = new Map<string, Directory>();
  try {
    for (const agent of agents) {
      workspaces.set(agent.id, await verifyDirectory(agent.workspacePath, "workspacePath", "safe"));
      homes.set(agent.id, await verifyDirectory(agent.runtimeHomePath, "runtimeHomePath", runtimeHomeShape(agent)));
      if (agent.recording) recordings.set(agent.id, await verifyDirectory(agent.recording.directory, "recording.directory", "private"));
    }
    const roots = [...workspaces.values(), ...homes.values(), ...recordings.values()];
    for (let left = 0; left < roots.length; left += 1) for (let right = left + 1; right < roots.length; right += 1) {
      const first = roots[left]!;
      const second = roots[right]!;
      if (sameIdentity(first.identity, second.identity) || overlaps(first.real, second.real)) {
        throw new Error(`physical runtime paths overlap: ${first.configured} and ${second.configured}`);
      }
    }
    for (const agent of agents) for (const source of agent.recording?.snapshots ?? []) {
      const real = await readableSnapshotDirectory(source.path);
      if (real !== undefined && [...recordings.values()].some((store) => pathsOverlap(store.real, real))) throw new Error("physical recording and snapshot paths overlap");
    }
  } catch (error) {
    const closeError = await closeAll([...workspaces.values(), ...homes.values(), ...recordings.values()]);
    if (closeError !== undefined) throw new AggregateError([error, closeError], "runtime path validation cleanup failed");
    throw error;
  }
  let closed = false;
  const verify = async (agent: OrganizationRuntimeAgentConfig): Promise<void> => {
    if (closed) throw new Error("runtime path authority is closed");
    const workspace = workspaces.get(agent.id);
    const home = homes.get(agent.id);
    if (workspace === undefined || home === undefined) throw new Error(`no runtime path authority for ${agent.id}`);
    await Promise.all([
      verifyIdentity(workspace, "workspacePath", "safe"),
      verifyIdentity(home, "runtimeHomePath", runtimeHomeShape(agent))
    ]);
  };
  return {
    forAgent(agent) {
      const workspace = workspaces.get(agent.id);
      const home = homes.get(agent.id);
      if (workspace === undefined || home === undefined) throw new Error(`no runtime path authority for ${agent.id}`);
      return { workspacePath: workspace.real, runtimeHomePath: home.real, verify: () => verify(agent) };
    },
    async close() {
      if (closed) return;
      const failure = await closeAll([...workspaces.values(), ...homes.values(), ...recordings.values()]);
      if (failure !== undefined) throw failure;
      closed = true;
    }
  };
}

async function verifyDirectory(configured: string, label: string, shape: DirectoryShape): Promise<Directory> {
  await assertNoSymlinkComponents(configured);
  const before = await lstat(configured);
  assertDirectory(before, label, shape);
  const fd = await open(configured, constants.O_RDONLY | directoryFlag() | noFollow());
  try {
    const opened = await fd.stat();
    const real = await realpath(configured);
    const after = await lstat(configured);
    if (!sameIdentity(identity(before), identity(opened)) || !sameIdentity(identity(before), identity(after))) {
      throw new Error(`${label} changed during validation`);
    }
    return { configured, real, fd, identity: identity(before), closed: false };
  } catch (error) {
    await fd.close().catch(() => undefined);
    throw error;
  }
}

async function verifyIdentity(directory: Directory, label: string, shape: DirectoryShape): Promise<void> {
  if (directory.closed) throw new Error(`${label} authority is closed`);
  await assertNoSymlinkComponents(directory.configured);
  const entry = await lstat(directory.configured);
  const opened = await directory.fd.stat();
  if (!sameIdentity(identity(entry), directory.identity) || !sameIdentity(identity(opened), directory.identity)) {
    throw new Error(`${label} changed after readiness validation`);
  }
  assertDirectory(entry, label, shape);
  if (await realpath(directory.configured) !== directory.real) throw new Error(`${label} changed after readiness validation`);
}

export async function assertNoSymlinkComponents(target: string): Promise<void> {
  const parsed = path.parse(target);
  let current = parsed.root;
  for (const part of path.relative(parsed.root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    // macOS exposes /var as a system compatibility symlink to /private/var.
    // It is an OS-root alias, not a caller-controlled component.
    if ((await lstat(current)).isSymbolicLink() && current !== "/var") throw new Error(`path contains symlink: ${current}`);
  }
}

/** Shared sources have no owner/privacy requirement. Missing sources are empty captures. */
async function readableSnapshotDirectory(target: string): Promise<string | undefined> {
  try {
    await assertNoSymlinkComponents(target);
    const entry = await lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("recording snapshot must be a readable real directory");
    await access(target, constants.R_OK | constants.X_OK);
    return await realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Identity of the process Daimon runs as; a seam so every refusal is testable unprivileged. */
export type RuntimeIdentity = Readonly<{ uid: number; gid: number; firstWorkerUid?: number }>;
type DirectoryEntry = Readonly<{ uid: number; gid: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean }>;

/** Pure shape check for a caller-prepared runtime root. */
export function assertRuntimeDirectory(entry: DirectoryEntry, label: string, shape: DirectoryShape, runtime: RuntimeIdentity): void {
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${label} must be an existing real directory`);
  if (entry.uid !== runtime.uid) throw new Error(`${label} must be owned by the runtime user`);
  const permissions = Number(entry.mode) & 0o7777;
  if (shape === "private" && permissions !== 0o700) throw new Error(`${label} must have mode 0700`);
  if (shape === "worker-traversable") {
    const home = GROK_ENGINE_BROKER.worker.home.organizationRuntimeHome;
    if (permissions !== home.mode) throw new Error(`${label} must have mode 0710 for a brokered Grok agent`);
    if (entry.gid < (runtime.firstWorkerUid ?? GROK_ENGINE_BROKER.identities.firstWorkerUid) || entry.gid === runtime.gid) {
      throw new Error(`${label} must be group-owned by the agent's Grok worker group`);
    }
  }
  if (shape === "safe" && (permissions & 0o022) !== 0) throw new Error(`${label} must not grant group or other write access`);
}

function assertDirectory(entry: Stats, label: string, shape: DirectoryShape): void {
  assertRuntimeDirectory(entry, label, shape, { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 });
}

function identity(entry: Stats): Identity { return { dev: entry.dev, ino: entry.ino, uid: entry.uid, mode: entry.mode & 0o7777 }; }
function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode; }
function overlaps(left: string, right: string): boolean { return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`); }
function noFollow(): number { return (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0; }
function directoryFlag(): number { return (constants as typeof constants & { O_DIRECTORY?: number }).O_DIRECTORY ?? 0; }
async function closeAll(directories: readonly Directory[]): Promise<AggregateError | undefined> {
  const results = await Promise.allSettled(directories.filter((directory) => !directory.closed).map(async (directory) => {
    await directory.fd.close();
    directory.closed = true;
  }));
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  return failures.length === 0 ? undefined : new AggregateError(failures, "runtime path authority cleanup failed");
}
