import { redactCredentialText } from "../core/credentialRedaction.js";
import {
  WAKE_ACCEPTANCE_VERSION,
  WAKE_RECEIPT_STATUS_VERSION,
  parseWakeAcceptanceRequest,
  sanitizeWakeCompletionText,
  type OrganizationRuntimeWakeAcceptance,
  type OrganizationRuntimeWakeAcceptanceRequest,
  type OrganizationRuntimeWakeReceiptStatus,
  type WakeReceiptCode,
  type WakeReceiptState,
  wakeAcceptanceDigest
} from "./wakeAcceptanceTypes.js";

export type StoredWakeAcceptanceRecord = Readonly<{
  acceptance_id: string; agent_id: string; delivery_id: string; request_digest: string;
  event: OrganizationRuntimeWakeAcceptanceRequest["event"]; state: WakeReceiptState;
  /** Set only through native scheduler acceptance; absent means a real delivery instant. */
  native_schedule?: true;
  accepted_at: string; updated_at: string; claim_generation?: string; execution_id?: string; deferred?: boolean; execution_error?: string; code?: WakeReceiptCode; text?: string;
}>;

export function publicAcceptance(record: StoredWakeAcceptanceRecord): OrganizationRuntimeWakeAcceptance {
  return { version: WAKE_ACCEPTANCE_VERSION, acceptance_id: record.acceptance_id, agent_id: record.agent_id, delivery_id: record.delivery_id, request_digest: record.request_digest, state: "accepted", accepted_at: record.accepted_at };
}
export function publicStatus(record: StoredWakeAcceptanceRecord): OrganizationRuntimeWakeReceiptStatus {
  return { version: WAKE_RECEIPT_STATUS_VERSION, acceptance_id: record.acceptance_id, agent_id: record.agent_id, delivery_id: record.delivery_id, request_digest: record.request_digest, state: record.state, accepted_at: record.accepted_at, updated_at: record.updated_at, ...(record.execution_id === undefined ? {} : { execution_id: record.execution_id }), ...(record.deferred === undefined ? {} : { deferred: record.deferred }), ...(record.code === undefined ? {} : { code: record.code }), ...(record.text === undefined ? {} : { text: record.text }) };
}
export function parseStoredWakeAcceptance(value: unknown): StoredWakeAcceptanceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("wake acceptance record is invalid");
  const record = value as Record<string, unknown>;
  const keys = ["acceptance_id", "agent_id", "delivery_id", "request_digest", "event", "state", "accepted_at", "updated_at", "claim_generation", "execution_id", "deferred", "execution_error", "code", "text", "native_schedule"];
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("wake acceptance record is invalid");
  const parsed = parseWakeAcceptanceRequest({ token: undefined, agent_id: string(record.agent_id), delivery_id: string(record.delivery_id), event: record.event });
  if (record.native_schedule !== undefined && (record.native_schedule !== true || parsed.event.kind !== "schedule")) throw new Error("wake acceptance schedule provenance is invalid");
  const state = string(record.state) as WakeReceiptState;
  if (!(["accepted", "running", "completed", "failed", "stopped"] as const).includes(state)) throw new Error("wake acceptance record is invalid");
  const code = record.code === undefined ? undefined : string(record.code) as WakeReceiptCode;
  const claimGeneration = record.claim_generation === undefined ? undefined : string(record.claim_generation);
  const executionId = record.execution_id === undefined ? undefined : string(record.execution_id);
  if (executionId !== undefined && !uuid(executionId) || record.deferred !== undefined && typeof record.deferred !== "boolean") throw new Error("wake acceptance attention state is invalid");
  const executionError = record.execution_error === undefined ? undefined : sanitizeExecutionError(string(record.execution_error));
  if (executionError === "" || record.execution_error !== undefined && Buffer.byteLength(string(record.execution_error)) > MAX_EXECUTION_ERROR_BYTES) throw new Error("wake acceptance execution error is invalid");
  const completionText = record.text === undefined ? undefined : sanitizeWakeCompletionText(string(record.text));
  if (claimGeneration !== undefined && !uuid(claimGeneration)) throw new Error("wake acceptance record is invalid");
  if (code !== undefined && !(["engine_failed", "host_stopped", "host_stopping", "queued_wake_stopped", "active_wake_aborted", "queue_full", "unknown_agent"] as const).includes(code)) throw new Error("wake acceptance record is invalid");
  // `accepted` is the one non-terminal state a record can be arrived at FROM an ended
  // execution: the dispatcher returns an undisposed delivery there for restart, and the
  // outcome that returned it is the only account of why. `running` and `completed` still
  // refuse a code, where one would be nonsense rather than evidence.
  if ((state === "running" || state === "completed") && code !== undefined) throw new Error("wake acceptance record is invalid");
  if ((state === "failed" || state === "stopped") && code === undefined) throw new Error("wake acceptance record is invalid");
  if ((state !== "completed" && state !== "failed" && completionText !== undefined) || completionText !== record.text) throw new Error("wake acceptance record is invalid");
  if (string(record.request_digest) !== wakeAcceptanceDigest(parsed) || !uuid(string(record.acceptance_id))) throw new Error("wake acceptance record is invalid");
  return { acceptance_id: string(record.acceptance_id), agent_id: parsed.agent_id, delivery_id: parsed.delivery_id, request_digest: string(record.request_digest), event: parsed.event, state, accepted_at: timestamp(record.accepted_at), updated_at: timestamp(record.updated_at), ...(record.native_schedule === true ? { native_schedule: true } : {}), ...(claimGeneration === undefined ? {} : { claim_generation: claimGeneration }), ...(executionId === undefined ? {} : { execution_id: executionId }), ...(record.deferred === undefined ? {} : { deferred: record.deferred as boolean }), ...(code === undefined ? {} : { code }), ...(completionText === undefined ? {} : { text: completionText }), ...(executionError === undefined ? {} : { execution_error: executionError }) };
}
function string(value: unknown): string { if (typeof value !== "string") throw new Error("wake acceptance record is invalid"); return value; }
function timestamp(value: unknown): string { const result = string(value); if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error("wake acceptance record is invalid"); return result; }
function uuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value); }

const MAX_EXECUTION_ERROR_BYTES = 2048;
/** Private failure diagnostic, surfaced through the existing availability error. */
export function sanitizeExecutionError(value: string): string {
  return redactCredentialText(value, [], MAX_EXECUTION_ERROR_BYTES).trim();
}
