import { WAKE_MOMENTS } from "../contracts/wakeMomentContract.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";
import type { StoredWakeAcceptanceRecord } from "./wakeAcceptanceRecord.js";
import { cleanMomentPaths, pinMomentStore, wakeMomentFailure, type MomentStore } from "./wakeMomentFs.js";
import { WakeMomentIo, type WakeMomentIoProbe } from "./wakeMomentIo.js";
import { captureWakeSnapshot, type WakeSnapshot } from "./wakeMomentSnapshot.js";
import { appendWakeMomentRow } from "./wakeMomentRows.js";
import { pruneWakeMoments } from "./wakeMomentRetention.js";
export { appendWakeMomentRow } from "./wakeMomentRows.js";
export { pruneWakeMoments } from "./wakeMomentRetention.js";

export type WakeMomentRow = {
  version: typeof WAKE_MOMENTS.version; agent_id: string; execution_id: string; started_at: string;
  deliveries: { acceptance_id: string; delivery_id: string; kind: string; occurred_at: string }[];
  snapshots: WakeSnapshot[]; error?: string;
};

/** Internal seams, intentionally absent from the public runtime barrel/config schema. */
export type WakeMomentOptions = {
  now?: () => number; captureDeadlineMs?: number; finalizationDeadlineMs?: number;
  maxManifestBytes?: number; probe?: WakeMomentIoProbe; verifyStore?: () => Promise<void>;
};

/** Advisory, per attempt, and completely inert for an agent without recording. */
export async function recordWakeMoment(agent: OrganizationRuntimeAgentConfig, executionId: string, records: readonly StoredWakeAcceptanceRecord[], options: WakeMomentOptions = {}): Promise<void> {
  const recording = agent.recording;
  if (!recording) return;
  const now = options.now ?? Date.now, io = new WakeMomentIo(options.probe), cleanup = new Set<string>();
  const errors: string[] = [];
  let store: MomentStore | undefined, row: WakeMomentRow | undefined;
  try {
    await io.bounded(options.captureDeadlineMs ?? WAKE_MOMENTS.captureDeadlineMs, async () => {
      store = await pinMomentStore(recording.directory, io, options.verifyStore);
      io.verifyWrite = (target) => store!.verify(io, target);
      await store.verify(io); // Immediately before capture, against the pinned root.
      row = {
        version: WAKE_MOMENTS.version, agent_id: agent.id, execution_id: executionId, started_at: new Date(now()).toISOString(),
        deliveries: records.map(({ acceptance_id, delivery_id, event }) => ({ acceptance_id, delivery_id, kind: event.kind, occurred_at: event.occurred_at })), snapshots: []
      };
      for (const root of recording.snapshots) {
        try {
          const captured = await captureWakeSnapshot({ directory: recording.directory, root, startedAt: row.started_at, executionId, io, cleanup, maxManifestBytes: options.maxManifestBytes });
          io.check();
          row.snapshots.push(captured.snapshot);
          if (captured.note) errors.push(`${root.id}: ${captured.note}`);
        } catch (error) {
          io.check(); // Deadline abandons the remaining roots, not just this one.
          if (wakeMomentFailure(error) === "recording_store_changed") throw error;
          errors.push(`${root.id}: ${wakeMomentFailure(error)}`);
        }
      }
    });
  } catch (error) { errors.push(wakeMomentFailure(error)); }
  // Capture is fenced before the row or cognition: late I/O completions cannot issue another write.
  const finalizer = new WakeMomentIo(options.probe);
  try {
    await finalizer.bounded(options.finalizationDeadlineMs ?? WAKE_MOMENTS.finalizationDeadlineMs, async () => {
      if (!store || !row) { logFailure(errors.join("; ")); return; }
      finalizer.verifyWrite = (target) => store!.verify(finalizer, target);
      if (errors.length) row.error = errors.join("; ").slice(0, 2048);
      // A stuck best-effort cleanup must not prevent the error row from being attempted.
      await Promise.all([
        cleanMomentPaths(cleanup, store, finalizer).catch((error) => logFailure(wakeMomentFailure(error))),
        (async () => {
          await appendWakeMomentRow(recording.directory, row!, finalizer);
          await pruneWakeMoments(recording, agent.id, now(), row, finalizer, store);
        })()
      ]);
    });
  } catch (error) { logFailure(wakeMomentFailure(error)); }
  finally { if (store) void store.close().catch(() => undefined); }
}

function logFailure(reason: string): void {
  try { console.error(`daimon: wake recording failed: ${reason}`); } catch { /* Logging is advisory too. */ }
}
