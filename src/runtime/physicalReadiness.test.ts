import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertRuntimeDirectory, prepareOrganizationRuntimePaths } from "./physicalReadiness.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

const agent = (workspacePath: string, runtimeHomePath: string): OrganizationRuntimeAgentConfig => ({
  id: "agent", name: "Agent", instructions: "Work.", workspacePath, runtimeHomePath, engine: { kind: "codex" }
});

test("preflight rejects missing or linked caller roots without creating anything", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-physical-"));
  const real = path.join(root, "real");
  const linked = path.join(root, "linked");
  const missing = path.join(root, "missing");
  const home = path.join(root, "home");
  try {
    await mkdir(real, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await symlink(real, linked);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(linked, home)]), /symlink/);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(missing, home)]), /ENOENT/);
    await assert.rejects(lstat(missing), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preflight requires safe workspace and private runtime roots, and proves physical isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-physical-"));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  try {
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    const authority = await prepareOrganizationRuntimePaths([agent(workspace, home)]);
    await authority.forAgent(agent(workspace, home)).verify();
    await authority.close();
    await chmod(home, 0o755);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, home)]), /mode 0700/);
    await chmod(home, 0o700);
    await chmod(workspace, 0o777);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, home)]), /write access/);
    await chmod(workspace, 0o700);
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, workspace)]), /overlap/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const withRoots = async (body: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-physical-"));
  try { await body(root); } finally { await rm(root, { force: true, recursive: true }); }
};

const runtime = { uid: 2000, gid: 2000, firstWorkerUid: 2200 };
const entry = (mode: number, uid = 2000, gid = 2000, kind: "dir" | "link" = "dir") => ({
  uid, gid, mode: (kind === "dir" ? 0o040000 : 0o120000) | mode,
  isDirectory: () => kind === "dir", isSymbolicLink: () => kind === "link"
});

test("a brokered Grok runtime home is accepted at exactly 2000:<worker gid> 0710 and nothing wider", () => {
  assert.doesNotThrow(() => assertRuntimeDirectory(entry(0o710, 2000, 2200), "runtimeHomePath", "worker-traversable", runtime));
  assert.doesNotThrow(() => assertRuntimeDirectory(entry(0o710, 2000, 2201), "runtimeHomePath", "worker-traversable", runtime));
  const refusals: Record<string, ReturnType<typeof entry>> = {
    "0700 (no worker traversal, pre-P1b layout)": entry(0o700, 2000, 2200),
    "0711 (world traverse)": entry(0o711, 2000, 2200),
    "0712": entry(0o712, 2000, 2200),
    "0714": entry(0o714, 2000, 2200),
    "0730 (group write)": entry(0o730, 2000, 2200),
    "0750 (group read)": entry(0o750, 2000, 2200),
    "0770": entry(0o770, 2000, 2200),
    "0777": entry(0o777, 2000, 2200),
    "2710 (setgid)": entry(0o2710, 2000, 2200),
    "owned by a worker": entry(0o710, 2200, 2200),
    "owned by root": entry(0o710, 0, 2200),
    "group is the runtime's own": entry(0o710, 2000, 2000),
    "group below the worker range": entry(0o710, 2000, 2100),
    "a symlink": entry(0o710, 2000, 2200, "link")
  };
  for (const [label, candidate] of Object.entries(refusals)) {
    assert.throws(() => assertRuntimeDirectory(candidate, "runtimeHomePath", "worker-traversable", runtime), /runtimeHomePath/u, label);
  }
});

test("every other engine's runtime home stays exactly 0700, and a workspace stays group/other-write free", () => {
  assert.doesNotThrow(() => assertRuntimeDirectory(entry(0o700), "runtimeHomePath", "private", runtime));
  for (const mode of [0o710, 0o701, 0o750, 0o770, 0o711, 0o755, 0o2700]) {
    assert.throws(() => assertRuntimeDirectory(entry(mode, 2000, 2200), "runtimeHomePath", "private", runtime), /must have mode 0700/u, mode.toString(8));
  }
  // The brokered Grok workspace contract (2000:<worker> 0750) passes the workspace shape.
  assert.doesNotThrow(() => assertRuntimeDirectory(entry(0o750, 2000, 2200), "workspacePath", "safe", runtime));
  assert.doesNotThrow(() => assertRuntimeDirectory(entry(0o700), "workspacePath", "safe", runtime));
  for (const mode of [0o770, 0o720, 0o702, 0o777]) {
    assert.throws(() => assertRuntimeDirectory(entry(mode, 2000, 2200), "workspacePath", "safe", runtime), /must not grant group or other write/u, mode.toString(8));
  }
});

test("the engine kind decides the runtime home shape on a real filesystem", async () => {
  await withRoots(async (root) => {
    const workspace = path.join(root, "workspace"), home = path.join(root, "home");
    await mkdir(workspace, { mode: 0o700 });
    await mkdir(home, { mode: 0o710 });
    const grok = { ...agent(workspace, home), engine: { kind: "grok" as const, model: "grok-4.6" as const, reasoningEffort: "low" as const } };
    // 0710 reaches the Grok branch: only the worker-group requirement is left to refuse it here.
    await assert.rejects(prepareOrganizationRuntimePaths([grok]), /group-owned by the agent's Grok worker group/u);
    // The same home refuses a Codex agent for being wider than 0700.
    await assert.rejects(prepareOrganizationRuntimePaths([agent(workspace, home)]), /must have mode 0700/u);
    await chmod(home, 0o700);
    const authority = await prepareOrganizationRuntimePaths([agent(workspace, home)]);
    await authority.close();
    await assert.rejects(prepareOrganizationRuntimePaths([grok]), /must have mode 0710 for a brokered Grok agent/u);
  });
});

test("recording requires a caller-created private real root, but sources can be missing or shared", async () => {
  await withRoots(async (root) => {
    const workspace = path.join(root, "workspace"), home = path.join(root, "home"), directory = path.join(root, "recording"), source = path.join(root, "source");
    await mkdir(workspace, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
    const configured = { ...agent(workspace, home), recording: { directory, keepMs: 1000, snapshots: [{ id: "state", path: source }] } };
    await assert.rejects(prepareOrganizationRuntimePaths([configured]), /ENOENT/);
    await assert.rejects(lstat(directory), /ENOENT/, "caller roots are never created by readiness");
    await mkdir(directory, { mode: 0o700 });
    const missing = await prepareOrganizationRuntimePaths([configured]); await missing.close();
    await mkdir(source, { mode: 0o777 }); await chmod(source, 0o777);
    const shared = await prepareOrganizationRuntimePaths([configured]); await shared.close();
    // An OS-owned readable source is valid: it need not belong to the runtime uid.
    const foreignOwner = await prepareOrganizationRuntimePaths([{ ...configured, recording: { ...configured.recording, snapshots: [{ id: "shared", path: "/usr/share" }] } }]);
    await foreignOwner.close();
    await chmod(directory, 0o755);
    await assert.rejects(prepareOrganizationRuntimePaths([configured]), /recording.directory must have mode 0700/);
    await chmod(directory, 0o700);
    await symlink(directory, path.join(root, "linked"));
    await assert.rejects(prepareOrganizationRuntimePaths([{ ...configured, recording: { ...configured.recording, directory: path.join(root, "linked") } }]), /symlink/);
    await assert.rejects(prepareOrganizationRuntimePaths([{ ...configured, recording: { ...configured.recording, snapshots: [{ id: "bad", path: directory }] } }]), /overlap/);
    assert.throws(() => assertRuntimeDirectory(entry(0o700, 2200), "recording.directory", "private", runtime), /owned by the runtime user/);
  });
});
