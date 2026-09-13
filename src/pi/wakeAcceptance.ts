import { resolveRunId } from "../observability/causalEvents.js";
import type { WakeEvent } from "../core/types.js";

import {
  candidateFromDelivery,
  type WakeAcceptanceAttempt,
  type WakeAcceptanceRecord,
  type WakeAcceptanceState,
  type WakeAcceptanceStoreState,
  WAKE_ACCEPTANCE_FILE_BYTES_MAX,
  WAKE_ACCEPTANCE_VERSION,
  WakeAcceptanceError,
  emptyWakeAcceptanceState,
  parseWakeAcceptanceState,
  pruneCompletedRecords,
  serializeWakeAcceptanceState
} from "./wakeAcceptanceSchema.js";
import { WakeAcceptanceFs } from "./wakeAcceptanceFs.js";

const UTF8 = "utf8";
const COMPLETED_STATE = "completed";
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;

export type WakeAcceptanceAdmission =
  | { mode: "replay" }
  | { mode: "run"; capability: WakeAcceptanceCapability };

const CAPABILITY_BRAND = Symbol("wake-acceptance-capability");

export interface WakeAcceptanceCapability {
  [CAPABILITY_BRAND]: "accepted" | "invoking";
}

type WakeAcceptanceCapabilityPhase = "accepted" | "invoking";

interface WakeAcceptanceCapabilityRecord {
  identity: string;
  digest: string;
  phase: WakeAcceptanceCapabilityPhase;
  sequence: number;
}

export interface WakeAcceptanceStoreLike {
  candidateFromDelivery(event: WakeEvent): WakeAcceptanceAttempt;
  begin(event: WakeEvent): Promise<WakeAcceptanceAdmission>;
  markInvoking(capability: WakeAcceptanceCapability): Promise<WakeAcceptanceCapability>;
  markCompleted(capability: WakeAcceptanceCapability): Promise<void>;
  markIncomplete(capability: WakeAcceptanceCapability): Promise<void>;
}

export class WakeAcceptanceStore {
  readonly runId: string;
  private readonly capabilities = new WeakMap<object, WakeAcceptanceCapabilityRecord>();

  constructor(
    readonly runtimeHomePath: string,
    readonly agentId: string,
    private readonly fs: WakeAcceptanceFs = new WakeAcceptanceFs(runtimeHomePath),
    causalRunId?: string
  ) {
    this.runId = resolveRunId(undefined, causalRunId);
  }

  getAcceptanceFilePath(): string {
    return this.fs.stateFilePath;
  }

  candidateFromDelivery(event: WakeEvent): WakeAcceptanceAttempt {
    return candidateFromDelivery({
      event,
      runId: this.runId,
      trustedAgentId: this.agentId
    });
  }

  candidateFromEvent(event: WakeEvent): WakeAcceptanceAttempt {
    return this.candidateFromDelivery(event);
  }

  async begin(event: WakeEvent): Promise<WakeAcceptanceAdmission> {
    const attempt = this.candidateFromDelivery(event);
    return this.beginFromAttempt(attempt);
  }

  private async beginFromAttempt(attempt: WakeAcceptanceAttempt): Promise<WakeAcceptanceAdmission> {
    let capability: WakeAcceptanceCapability | undefined;
    const admission = await this.withClaim<WakeAcceptanceRecord | "replay">(async () => {
      await this.fs.cleanupTemps();
      const state = await this.loadStateUnsafe();
      const existing = state.records.find((record) => record.identity === attempt.identity);

      if (existing !== undefined) {
        if (existing.digest !== attempt.digest) {
          throw this.makeError("wake_delivery_conflict", true);
        }
        if (existing.state !== COMPLETED_STATE) {
          throw this.makeError("wake_delivery_incomplete", true);
        }
        return "replay";
      }

      const nextSequence = this.nextSequence(state.next_sequence);
      const nextState = this.makeRecord(attempt, "accepted", nextSequence);
      const withAddition = pruneCompletedRecords([...state.records, nextState]);
      const nextStore: WakeAcceptanceStoreState = {
        ...state,
        next_sequence: nextState.sequence,
        records: withAddition
      };

      await this.persistState(nextStore);
      return nextState;
    }, (result) => {
      if (result === "replay") {
        return;
      }

      capability = this.createCapability({
        identity: result.identity,
        digest: result.digest,
        phase: "accepted",
        sequence: result.sequence
      });
    });

    if (admission === "replay") {
      return { mode: "replay" };
    }

    if (capability === undefined) {
      throw this.makeError("wake_acceptance_store_corrupt", false);
    }

    return { mode: "run", capability };
  }

  async markInvoking(capability: WakeAcceptanceCapability): Promise<WakeAcceptanceCapability> {
    const issued = this.consumeCapability(capability, "accepted");
    let replacement: WakeAcceptanceCapability | undefined;

    return this.withClaim(async () => {
      return this.transitionAttempt(issued, "invoking");
    }, (record) => {
      this.capabilities.delete(capability as unknown as object);
      replacement = this.createCapability({
        identity: record.identity,
        digest: record.digest,
        phase: "invoking",
        sequence: record.sequence
      });
    }).then(() => {
      if (replacement === undefined) {
        throw this.makeError("wake_acceptance_store_corrupt", false);
      }
      return replacement;
    });
  }

  async markCompleted(capability: WakeAcceptanceCapability): Promise<void> {
    const issued = this.consumeCapability(capability, "invoking");

    await this.withClaim(async () => {
      await this.transitionAttempt(issued, COMPLETED_STATE);
    }, () => {
      this.capabilities.delete(capability as unknown as object);
    });
  }

  async markIncomplete(capability: WakeAcceptanceCapability): Promise<void> {
    const issued = this.consumeCapability(capability, "accepted", "invoking");

    await this.withClaim(async () => {
      await this.transitionAttempt(issued, "incomplete");
    }, () => {
      this.capabilities.delete(capability as unknown as object);
    });
  }

  async loadState(): Promise<WakeAcceptanceStoreState> {
    const raw = await this.fs.readStateText();
    if (raw === undefined) {
      return emptyWakeAcceptanceState({
        runId: this.runId,
        agentId: this.agentId
      });
    }

    try {
      return parseWakeAcceptanceState(JSON.parse(raw), { runId: this.runId, agentId: this.agentId });
    } catch (error) {
      if (error instanceof WakeAcceptanceError) {
        throw this.makeError(error.code, true);
      }
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }
  }

  private async loadStateUnsafe(): Promise<WakeAcceptanceStoreState> {
    return this.loadState();
  }

  private makeRecord(
    attempt: WakeAcceptanceAttempt,
    state: WakeAcceptanceState,
    sequence: number
  ): WakeAcceptanceRecord {
    return {
      body_sha256: attempt.bodySha256,
      context_id: attempt.contextId,
      digest: attempt.digest,
      event_id: attempt.eventId,
      identity: attempt.identity,
      kind: attempt.kind,
      sender: attempt.sender,
      state,
      sequence,
      target: attempt.target
    };
  }

  private makeError(
    code: WakeAcceptanceError["code"],
    safeToRelease: boolean
  ): WakeAcceptanceError {
    const error = new WakeAcceptanceError(code);
    (error as WakeAcceptanceError & { safeToRelease: boolean }).safeToRelease = safeToRelease;
    return error;
  }

  private canRelease(error: unknown): boolean {
    if (!(error instanceof WakeAcceptanceError)) {
      return false;
    }
    const info = error as WakeAcceptanceError & { safeToRelease?: boolean };
    return info.safeToRelease !== false;
  }

  private async withClaim<T>(
    operation: () => Promise<T>,
    afterRelease?: (result: T) => Promise<void> | void
  ): Promise<T> {
    await this.fs.acquireClaim();
    let result: T;

    try {
      result = await operation();
    } catch (error) {
      if (this.canRelease(error)) {
        try {
          await this.fs.releaseClaim();
        } catch (releaseError) {
          if (releaseError instanceof WakeAcceptanceError) {
            throw releaseError;
          }
          throw this.makeError("wake_acceptance_store_corrupt", false);
        }
      }
      throw error;
    }

    try {
      await this.fs.releaseClaim();
    } catch (error) {
      if (error instanceof WakeAcceptanceError) {
        throw error;
      }
      throw this.makeError("wake_acceptance_store_corrupt", false);
    }

    if (afterRelease !== undefined) {
      await afterRelease(result!);
    }

    return result!;
  }

  private createCapability(record: WakeAcceptanceCapabilityRecord): WakeAcceptanceCapability {
    const token = {
      [CAPABILITY_BRAND]: record.phase
    } as WakeAcceptanceCapability;
    this.capabilities.set(token as unknown as object, record);
    return token;
  }

  private consumeCapability(
    capability: WakeAcceptanceCapability,
    ...phases: WakeAcceptanceCapabilityPhase[]
  ): WakeAcceptanceCapabilityRecord {
    const record = this.capabilities.get(capability as unknown as object);
    if (record === undefined) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }
    if (!phases.includes(record.phase)) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }
    return record;
  }

  private async transitionAttempt(
    data: WakeAcceptanceCapabilityRecord,
    nextState: WakeAcceptanceState
  ): Promise<WakeAcceptanceRecord> {
    const state = await this.loadStateUnsafe();
    const index = state.records.findIndex((record) => record.identity === data.identity);

    if (index === -1) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    const existing = state.records[index];
    if (existing.digest !== data.digest) {
      throw this.makeError("wake_delivery_conflict", true);
    }

    if (data.sequence !== existing.sequence) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    if (nextState === "invoking" && existing.state !== "accepted") {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    if (nextState === COMPLETED_STATE && existing.state !== "invoking") {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    if (nextState === "incomplete" && existing.state !== "accepted" && existing.state !== "invoking") {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    if (nextState === existing.state) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    const nextSequence = this.nextSequence(state.next_sequence);
    const next = {
      ...existing,
      sequence: nextSequence,
      state: nextState
    } as WakeAcceptanceRecord;

    const records = [...state.records];
    records[index] = next;

    const nextStore = {
      ...state,
      next_sequence: nextSequence,
      records: pruneCompletedRecords(records)
    } as WakeAcceptanceStoreState;

    await this.persistState(nextStore);
    return next;
  }

  private async persistState(state: WakeAcceptanceStoreState): Promise<void> {
    const body = serializeWakeAcceptanceState(state);
    if (Buffer.byteLength(body, UTF8) > WAKE_ACCEPTANCE_FILE_BYTES_MAX) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    if (state.version !== WAKE_ACCEPTANCE_VERSION) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    const validated = parseWakeAcceptanceState(JSON.parse(body), {
      runId: this.runId,
      agentId: this.agentId
    });
    const canonical = serializeWakeAcceptanceState(validated);
    if (Buffer.byteLength(canonical, UTF8) > WAKE_ACCEPTANCE_FILE_BYTES_MAX) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }

    await this.fs.writeStateText(canonical);
  }

  private nextSequence(previous: number): number {
    if (previous >= MAX_SEQUENCE) {
      throw this.makeError("wake_acceptance_store_corrupt", true);
    }
    return previous + 1;
  }
}

export {
  WAKE_ACCEPTANCE_VERSION,
  WakeAcceptanceError,
  type WakeAcceptanceAttempt,
  type WakeAcceptanceRecord,
  type WakeAcceptanceState,
  type WakeAcceptanceStoreState
} from "./wakeAcceptanceSchema.js";
