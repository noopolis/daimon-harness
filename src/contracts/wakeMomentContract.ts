/** Data-only capability and on-disk bounds; presence in the manifest enables callers. */
export const WAKE_MOMENTS = {
  version: "noopolis.daimon.wake-moment.v1",
  rowsFile: "wake-moments.jsonl",
  snapshotsDirectory: "snapshots",
  maxSnapshotRoots: 16,
  maxSnapshotEntries: 200_000,
  maxRowBytes: 4_194_304,
  configField: "agents[].recording"
} as const;

export type WakeMomentRecording = Readonly<{
  directory: string;
  keepMs: number;
  snapshots: readonly Readonly<{ id: string; path: string }>[];
}>;

const absolutePath = { type: "string", pattern: "^/[^\\u0000]*$", maxLength: 4_096 } as const;
export const WAKE_MOMENT_RECORDING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["directory", "keepMs", "snapshots"],
  properties: {
    directory: absolutePath,
    keepMs: { type: "integer", minimum: 1, maximum: 9_007_199_254_740_991 },
    snapshots: { type: "array", maxItems: WAKE_MOMENTS.maxSnapshotRoots, uniqueItems: true, items: {
      type: "object", additionalProperties: false, required: ["id", "path"], properties: {
        id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}$" }, path: absolutePath
      }
    } }
  }
} as const;
