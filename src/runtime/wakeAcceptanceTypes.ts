import { createHash } from "node:crypto";

import { ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION } from "../contracts/runtimeContractManifest.js";
import { redactCredentialText } from "../core/credentialRedaction.js";

export const WAKE_ACCEPTANCE_VERSION = "noopolis.daimon.wake-acceptance.v2" as const;
export const WAKE_RECEIPT_STATUS_VERSION = "noopolis.daimon.wake-receipt-status.v2" as const;
export const WAKE_V2_VERSION = "noopolis.daimon.wake.v2" as const;
export const ACTIVITY_V2_VERSION = ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION;
export const MAX_WAKE_ACCEPTANCE_BYTES = 16_384;
export const MAX_WAKE_ACCEPTANCE_RECORD_BYTES = 65_536;
export const MAX_WAKE_COMPLETION_TEXT_BYTES = 16_384;

/** Public HTTP body schema; bearer authentication is intentionally a header. */
export const WAKE_ACCEPTANCE_REQUEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "noopolis.daimon.wake-request.v2", type: "object", additionalProperties: false,
  required: ["agent_id", "delivery_id", "event"], properties: {
    agent_id: { type: "string", minLength: 1, maxLength: MAX_WAKE_ACCEPTANCE_BYTES, pattern: "\\S" },
    delivery_id: { type: "string", minLength: 1, maxLength: MAX_WAKE_ACCEPTANCE_BYTES, pattern: "\\S" },
    event: { type: "object", additionalProperties: false, required: ["version", "kind", "text", "occurred_at"], properties: {
      version: { const: WAKE_V2_VERSION }, kind: { enum: ["manual", "message", "schedule", "external"] }, text: { type: "string", maxLength: MAX_WAKE_ACCEPTANCE_BYTES }, occurred_at: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }
    } }
  }
} as const;
export const WAKE_RECEIPT_STATUS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: WAKE_RECEIPT_STATUS_VERSION, type: "object", additionalProperties: false,
  required: ["version", "acceptance_id", "agent_id", "delivery_id", "request_digest", "state", "accepted_at", "updated_at"], properties: {
    version: { const: WAKE_RECEIPT_STATUS_VERSION }, acceptance_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, agent_id: { type: "string" }, delivery_id: { type: "string" }, request_digest: { type: "string", pattern: "^[a-f0-9]{64}$" }, state: { enum: ["accepted", "running", "completed", "failed", "stopped"] }, accepted_at: { type: "string" }, updated_at: { type: "string" }, execution_id: { type: "string", pattern: "^[0-9a-f-]{36}$" }, deferred: { type: "boolean" }, code: { enum: ["engine_failed", "host_stopped", "host_stopping", "queued_wake_stopped", "active_wake_aborted", "queue_full", "unknown_agent"] }, text: { type: "string", maxLength: MAX_WAKE_COMPLETION_TEXT_BYTES }
  }
} as const;

export type WakeReceiptState = "accepted" | "running" | "completed" | "failed" | "stopped";
/**
 * Why a receipt reached its state, and every member is a state the runtime really
 * produces: `queued_wake_stopped` and `active_wake_aborted` are the two shapes a
 * shutdown gives a wake (`organizationRuntimeHost.ts` settles a queued job with the
 * first and the in-flight one with the second), and a delivery reclaimed for restart
 * used to record neither, because the only caller that could name them passed no
 * code at all. A code that cannot be determined stays ABSENT: a plausible name for
 * an undetermined cause is worse than no name, because it is acted on.
 */
export type WakeReceiptCode = "engine_failed" | "host_stopped" | "host_stopping" | "queued_wake_stopped" | "active_wake_aborted" | "queue_full" | "unknown_agent";
export type OrganizationRuntimeWakeAcceptanceRequest = Readonly<{
  token: string | undefined;
  agent_id: string;
  delivery_id: string;
  event: Readonly<{ version: typeof WAKE_V2_VERSION; kind: "manual" | "message" | "schedule" | "external"; text: string; occurred_at: string }>;
}>;
export type OrganizationRuntimeWakeAcceptance = Readonly<{
  version: typeof WAKE_ACCEPTANCE_VERSION;
  acceptance_id: string;
  agent_id: string;
  delivery_id: string;
  request_digest: string;
  state: "accepted";
  accepted_at: string;
}>;
export type OrganizationRuntimeWakeReceiptStatus = Readonly<{
  version: typeof WAKE_RECEIPT_STATUS_VERSION;
  acceptance_id: string;
  agent_id: string;
  delivery_id: string;
  request_digest: string;
  state: WakeReceiptState;
  accepted_at: string;
  updated_at: string;
  execution_id?: string;
  deferred?: boolean;
  code?: WakeReceiptCode;
  text?: string;
}>;

/** Bounded authenticated reply payload; strips common credential shapes before persistence. */
export function sanitizeWakeCompletionText(value: string): string {
  return redactCredentialText(value, [], MAX_WAKE_COMPLETION_TEXT_BYTES);
}
export type OrganizationRuntimeActivityV2Item = OrganizationRuntimeWakeReceiptStatus & Readonly<{
  active: boolean;
  queue_position?: number;
}>;
export type OrganizationRuntimeActivityV2 = Readonly<{
  version: typeof ACTIVITY_V2_VERSION;
  /**
   * Whether this projection was read from a live runtime or sealed as the host
   * stopped. Optional on the wire because a projection published before the seal
   * existed must still parse; its absence means "not stated", never "running".
   */
  state?: "running" | "stopped";
  items: readonly OrganizationRuntimeActivityV2Item[];
  executions?: readonly Readonly<{ agent_id: string; execution_id: string; state: "running"; delivery_ids: readonly string[] }>[];
}>;
export type OrganizationRuntimeWakeAcceptanceResult = OrganizationRuntimeWakeAcceptance | Readonly<{
  version: typeof WAKE_ACCEPTANCE_VERSION;
  state: "rejected" | "stopped";
  blocked?: Readonly<{ version: "noopolis.daimon.work-blocked.v1"; reason: "operator_stop" | "ledger_unavailable" | "host_stopping" | "host_stopped" | "queue_full"; retry_after_ms: number }>;
  code: "unauthorized" | "invalid_request" | "unknown_agent" | "host_stopping" | "host_stopped" | "delivery_conflict";
}>;

/** A stored record holds its escaped wake text plus envelope; the bound scales with a declared wider text bound. */
export function wakeAcceptanceRecordBytes(maxTextBytes = MAX_WAKE_ACCEPTANCE_BYTES): number { return Math.max(MAX_WAKE_ACCEPTANCE_RECORD_BYTES, maxTextBytes * 4); }

export function parseWakeAcceptanceRequest(value: unknown, maxTextBytes = MAX_WAKE_ACCEPTANCE_BYTES): OrganizationRuntimeWakeAcceptanceRequest {
  const root = record(snapshot(value, "wake acceptance"), "wake acceptance");
  exact(root, ["token", "agent_id", "delivery_id", "event"], "wake acceptance");
  const event = record(root.event, "wake acceptance.event");
  exact(event, ["version", "kind", "text", "occurred_at"], "wake acceptance.event");
  const kind = text(event.kind, "wake acceptance.event.kind");
  if (kind !== "manual" && kind !== "message" && kind !== "schedule" && kind !== "external") throw new TypeError("wake acceptance.event.kind is not supported");
  const body = text(event.text, "wake acceptance.event.text", maxTextBytes);
  if (Buffer.byteLength(body, "utf8") > maxTextBytes) throw new TypeError("wake acceptance.event.text exceeds the wake text limit");
  if (text(event.version, "wake acceptance.event.version") !== WAKE_V2_VERSION) throw new TypeError("wake acceptance.event.version is not supported");
  return {
    token: root.token === undefined ? undefined : text(root.token, "wake acceptance.token"),
    agent_id: nonBlank(root.agent_id, "wake acceptance.agent_id"),
    delivery_id: nonBlank(root.delivery_id, "wake acceptance.delivery_id"),
    event: { version: WAKE_V2_VERSION, kind, text: body, occurred_at: rfc3339(event.occurred_at) }
  };
}

export function wakeAcceptanceDigest(request: OrganizationRuntimeWakeAcceptanceRequest): string {
  const canonical = JSON.stringify({ agent_id: request.agent_id, delivery_id: request.delivery_id, event: request.event });
  return createHash("sha256").update(canonical).digest("hex");
}

function snapshot(value: unknown, label: string): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  const copied: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data property`);
    copied[key] = snapshot(descriptor.value, `${label}.${key}`);
  }
  return copied;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !expected.includes(key)) || expected.some((key) => !Object.hasOwn(value, key))) throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`);
}
function text(value: unknown, label: string, maxBytes = MAX_WAKE_ACCEPTANCE_BYTES): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new TypeError(`${label} must be a bounded string`);
  return value;
}
function nonBlank(value: unknown, label: string): string { const result = text(value, label); if (!result.trim()) throw new TypeError(`${label} must not be blank`); return result; }
function rfc3339(value: unknown): string {
  const result = nonBlank(value, "wake acceptance.event.occurred_at");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError("wake acceptance.event.occurred_at must be an exact RFC3339 timestamp");
  return result;
}
