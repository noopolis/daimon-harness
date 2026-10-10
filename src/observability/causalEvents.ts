import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ensureRuntimeHomeDirectory } from "../runtime/runtimeHomeLayout.js";

/**
 * Daimon's own copy of the `noopolis.causal-event.v1` wire envelope. Field-
 * for-field the canonical shape in `specs/causal-event.v1.schema.json` and
 * `specs/CAUSAL.md` (root repo) — daimon is an independent repo and does not
 * import that schema, it only conforms to it. The wire JSON emitted by
 * `appendCausalEvent` is the actual contract; this type is local sugar over
 * it.
 */
export const CAUSAL_EVENT_VERSION = "noopolis.causal-event.v1" as const;

export type CausalEventSystem = "simfile" | "moltnet" | "mneme" | "daimon";

export interface CausalEventEmitter {
  system: CausalEventSystem;
  stream_id: string;
  seq: number;
}

export interface CausalEvent<TPayload = Record<string, unknown>> {
  cause_event_ids: string[];
  emitter: CausalEventEmitter;
  event_id: string;
  payload: TPayload;
  principal_id: string;
  recorded_at: string;
  run_id: string;
  type: string;
  version: typeof CAUSAL_EVENT_VERSION;
}

/** Payload for `turn.input.submitted`, stamped just before a Pi session prompt call. */
export interface TurnInputSubmittedPayload extends Record<string, unknown> {
  input_content_sha256: string;
  input_message_ids: string[];
  prompt_sha256: string;
  turn_id: string;
}

/** Payload for `turn.output.completed`, stamped once a Pi turn finishes successfully. */
export interface TurnOutputCompletedPayload extends Record<string, unknown> {
  output_sha256: string;
  turn_id: string;
}

export const TURN_INPUT_SUBMITTED_TYPE = "turn.input.submitted" as const;
export const TURN_OUTPUT_COMPLETED_TYPE = "turn.output.completed" as const;

/** Name of the environment variable every Noopolis authority reads `run_id` from. Never model output. */
export const NOOPOLIS_RUN_ID_ENV = "NOOPOLIS_RUN_ID";

/**
 * Resolves `run_id` from explicit trusted host context or the historical
 * `NOOPOLIS_RUN_ID` environment fallback. Never derived from a WakeEvent, model output, or any
 * other in-turn data. A causal event cannot be emitted without a real run id.
 */
export const resolveRunId = (env: NodeJS.ProcessEnv = process.env, explicitRunId?: string): string => {
  const value = explicitRunId ?? env[NOOPOLIS_RUN_ID_ENV];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${NOOPOLIS_RUN_ID_ENV} must be set to a non-blank value`);
  }
  return value.trim();
};

export const sha256Hex = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Deterministic, non-model-derived event id for a turn's `turn.input.submitted` record. */
export const turnInputSubmittedEventId = (turnId: string): string => `daimon:${turnId}:turn.input.submitted`;

/** Deterministic, non-model-derived event id for a turn's `turn.output.completed` record. */
export const turnOutputCompletedEventId = (turnId: string): string => `daimon:${turnId}:turn.output.completed`;

/**
 * The `cause_event_ids` an outbound Moltnet reply for `turnId` should carry.
 * Pure and deterministic from `turn_id` alone — the harness owns this value,
 * never the model. Daimon does not construct Moltnet `SendMessageRequest`
 * values itself (see repo AGENTS.md: Moltnet wiring belongs to the caller,
 * not this package), so this helper is what a caller sending the reply on
 * Daimon's behalf attaches to that request's `cause_event_ids`.
 */
export const replyCauseEventIds = (turnId: string): string[] => [turnOutputCompletedEventId(turnId)];

const telemetryDir = (runtimeHomePath: string): string => path.join(runtimeHomePath, "telemetry");
const seqFilePath = (runtimeHomePath: string): string => path.join(telemetryDir(runtimeHomePath), "causal.seq.json");
const jsonlFilePath = (runtimeHomePath: string): string => path.join(telemetryDir(runtimeHomePath), "causal.jsonl");
const STALE_LOCK_MS = 30_000;
const seqAllocationQueues = new Map<string, Promise<unknown>>();

/** run_id -> stream_id -> last assigned seq. */
type CausalSeqStore = Record<string, Record<string, number>>;

const readSeqStore = async (runtimeHomePath: string): Promise<CausalSeqStore> => {
  try {
    const raw = await readFile(seqFilePath(runtimeHomePath), "utf8");
    return JSON.parse(raw) as CausalSeqStore;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

const writeSeqStore = async (runtimeHomePath: string, store: CausalSeqStore): Promise<void> => {
  const directory = await ensureRuntimeHomeDirectory(runtimeHomePath, "telemetry");
  const file = seqFilePath(runtimeHomePath);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const acquireSeqLock = async (lockPath: string): Promise<void> => {
  const startedAt = Date.now();
  let backoffMs = 2;
  while (Date.now() - startedAt < 5_000) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.close();
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    try {
      const observed = await stat(lockPath);
      if (Date.now() - observed.mtimeMs > STALE_LOCK_MS) {
        const confirmed = await stat(lockPath);
        if (confirmed.mtimeMs === observed.mtimeMs) {
          await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
          continue;
        }
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    backoffMs = Math.min(backoffMs * 2, 25);
  }
  throw new Error(`Timed out acquiring causal sequence lock: ${lockPath}`);
};

/**
 * Allocates the next contiguous seq number for `(run_id, stream_id)`,
 * persisted under `runtimeHome/telemetry/causal.seq.json`. Allocation is
 * serialized in-process and mutually excluded across processes by a lock
 * file; the counter is written atomically and fsynced.
 */
export const nextCausalSeq = async (input: {
  runId: string;
  runtimeHomePath: string;
  streamId: string;
}): Promise<number> => {
  const lockPath = path.resolve(telemetryDir(input.runtimeHomePath), "causal.seq.lock");
  const previous = seqAllocationQueues.get(lockPath) ?? Promise.resolve();
  const allocation = previous.catch(() => undefined).then(async () => {
    await ensureRuntimeHomeDirectory(input.runtimeHomePath, "telemetry");
    await acquireSeqLock(lockPath);
    try {
      const store = await readSeqStore(input.runtimeHomePath);
      const forRun = store[input.runId] ?? {};
      const next = (forRun[input.streamId] ?? 0) + 1;
      forRun[input.streamId] = next;
      store[input.runId] = forRun;
      await writeSeqStore(input.runtimeHomePath, store);
      return next;
    } finally {
      await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  });
  seqAllocationQueues.set(lockPath, allocation);
  void allocation.finally(() => {
    if (seqAllocationQueues.get(lockPath) === allocation) seqAllocationQueues.delete(lockPath);
  }).catch(() => undefined);
  return allocation;
};

/** Appends one CausalEvent record as a line of `runtimeHome/telemetry/causal.jsonl`. */
export const appendCausalEvent = async (runtimeHomePath: string, event: CausalEvent): Promise<void> => {
  await ensureRuntimeHomeDirectory(runtimeHomePath, "telemetry");
  await appendFile(jsonlFilePath(runtimeHomePath), `${JSON.stringify(event)}\n`, "utf8");
};

export interface EmitCausalEventInput<TPayload extends Record<string, unknown>> {
  agentId: string;
  causeEventIds: string[];
  eventId: string;
  payload: TPayload;
  principalId: string;
  runId: string;
  runtimeHomePath: string;
  type: string;
}

/**
 * Stamps and appends one causal event for this agent's stream
 * (`agent:<agentId>`). `run_id` and `principal_id` are always caller-
 * supplied values (never read from `payload` or model output) — see
 * `piHarness.ts`, which is the only caller and always passes the resolved
 * `NOOPOLIS_RUN_ID` and the authenticated agent identity.
 */
export const emitCausalEvent = async <TPayload extends Record<string, unknown>>(
  input: EmitCausalEventInput<TPayload>
): Promise<CausalEvent<TPayload>> => {
  const streamId = `agent:${input.agentId}`;
  const seq = await nextCausalSeq({ runId: input.runId, runtimeHomePath: input.runtimeHomePath, streamId });
  const event: CausalEvent<TPayload> = {
    cause_event_ids: [...input.causeEventIds],
    emitter: { system: "daimon", stream_id: streamId, seq },
    event_id: input.eventId,
    payload: input.payload,
    principal_id: input.principalId,
    recorded_at: new Date().toISOString(),
    run_id: input.runId,
    type: input.type,
    version: CAUSAL_EVENT_VERSION
  };
  await appendCausalEvent(input.runtimeHomePath, event);
  return event;
};

export interface EmitTurnInputSubmittedInput {
  agentId: string;
  causeEventIds: string[];
  inputContentSha256: string;
  inputMessageIds: string[];
  principalId: string;
  promptSha256: string;
  runId: string;
  runtimeHomePath: string;
  turnId: string;
}

/** Stamps `turn.input.submitted` for one Pi turn, right before the engine prompt call. */
export const emitTurnInputSubmitted = (
  input: EmitTurnInputSubmittedInput
): Promise<CausalEvent<TurnInputSubmittedPayload>> =>
  emitCausalEvent({
    agentId: input.agentId,
    causeEventIds: input.causeEventIds,
    eventId: turnInputSubmittedEventId(input.turnId),
    payload: {
      input_content_sha256: input.inputContentSha256,
      input_message_ids: [...input.inputMessageIds],
      prompt_sha256: input.promptSha256,
      turn_id: input.turnId
    },
    principalId: input.principalId,
    runId: input.runId,
    runtimeHomePath: input.runtimeHomePath,
    type: TURN_INPUT_SUBMITTED_TYPE
  });

export interface EmitTurnOutputCompletedInput {
  agentId: string;
  causeEventIds: string[];
  outputSha256: string;
  principalId: string;
  runId: string;
  runtimeHomePath: string;
  turnId: string;
}

/** Stamps `turn.output.completed` once a Pi turn finishes successfully. */
export const emitTurnOutputCompleted = (
  input: EmitTurnOutputCompletedInput
): Promise<CausalEvent<TurnOutputCompletedPayload>> =>
  emitCausalEvent({
    agentId: input.agentId,
    causeEventIds: input.causeEventIds,
    eventId: turnOutputCompletedEventId(input.turnId),
    payload: {
      output_sha256: input.outputSha256,
      turn_id: input.turnId
    },
    principalId: input.principalId,
    runId: input.runId,
    runtimeHomePath: input.runtimeHomePath,
    type: TURN_OUTPUT_COMPLETED_TYPE
  });
