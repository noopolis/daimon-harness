import path from "node:path";
import { WAKE_MOMENTS, type WakeMomentRecording } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

/** Receives the parser's already cloned JSON data; no I/O or caller hooks. */
export function parseRecording(value: unknown): WakeMomentRecording {
  const input = exact(value, ["directory", "keepMs", "snapshots"]);
  const directory = absolute(input.directory);
  if (typeof input.keepMs !== "number" || !Number.isSafeInteger(input.keepMs) || input.keepMs <= 0) throw new TypeError("recording.keepMs must be a positive safe integer");
  if (!Array.isArray(input.snapshots) || input.snapshots.length > WAKE_MOMENTS.maxSnapshotRoots) throw new TypeError("recording.snapshots must have 0..16 roots");
  const ids = new Set<string>(), paths = new Set<string>();
  const snapshots = input.snapshots.map((value) => {
    const root = exact(value, ["id", "path"]);
    if (typeof root.id !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(root.id)) throw new TypeError("recording snapshot id is invalid");
    const source = absolute(root.path);
    if (ids.has(root.id) || paths.has(source)) throw new TypeError("recording snapshots must have unique ids and paths");
    if (pathsOverlap(source, directory)) throw new TypeError("recording snapshot and directory must not overlap");
    ids.add(root.id); paths.add(source);
    return { id: root.id, path: source };
  });
  return { directory, keepMs: input.keepMs, snapshots };
}

export function isolateRecording(agents: readonly OrganizationRuntimeAgentConfig[]): void {
  for (const agent of agents) {
    if (!agent.recording) continue;
    for (const peer of agents) {
      for (const root of [peer.workspacePath, peer.runtimeHomePath, ...(peer.id === agent.id || !peer.recording ? [] : [peer.recording.directory])]) {
        if (pathsOverlap(agent.recording.directory, root)) throw new TypeError("recording.directory must not overlap runtime roots");
      }
      for (const snapshot of peer.recording?.snapshots ?? []) {
        if (pathsOverlap(agent.recording.directory, snapshot.path)) throw new TypeError("recording.directory must not overlap snapshot roots");
      }
    }
  }
}

export function pathsOverlap(left: string, right: string): boolean {
  return left === right || left === "/" || right === "/" || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("recording requires objects");
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) throw new TypeError("recording has invalid fields");
  return value as Record<string, unknown>;
}
function absolute(value: unknown): string {
  if (typeof value !== "string" || !path.posix.isAbsolute(value) || value.includes("\0") || [...value].length > 4_096 || Buffer.byteLength(value) > 16_384) throw new TypeError("recording paths must be bounded absolute POSIX paths");
  // Match workspacePath/runtimeHomePath: canonicalize before testing equality/overlap.
  return path.posix.normalize(value).replace(/\/+$/, "") || "/";
}
