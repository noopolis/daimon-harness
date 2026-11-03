import { ENGINE_DESCRIPTORS, SORTED_ENGINE_IDS } from "../engines/descriptors.js";
import { WAKE_MOMENTS } from "./wakeMomentContract.js";
import { OPERATOR_DRAIN, WORK_AVAILABILITY_SCHEMA, WORK_BLOCKED_SCHEMA } from "./attentionContract.js";
import {
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS
} from "./organizationRuntimeContract.js";

export const RUNTIME_CONTRACT_MANIFEST_VERSION = "noopolis.daimon.runtime-contract-manifest.v7" as const;
export const ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION = "noopolis.daimon.organization-runtime-activity.v2" as const;
export const ENGINE_CREDENTIAL_MATERIAL = {
  codex: ENGINE_DESCRIPTORS.codex.credentialMaterial
} as const;
export const CODEX_SUBSCRIPTION_REALM = ENGINE_DESCRIPTORS.codex.auth.realm;
export const GROK_SUBSCRIPTION_REALM = ENGINE_DESCRIPTORS.grok.auth.realm;
export const GROK_ENGINE_BROKER = ENGINE_DESCRIPTORS.grok.broker;
export const AGY_SUBSCRIPTION_REALM = ENGINE_DESCRIPTORS.agy.auth.realm;

const text = { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" } as const;
const boundedText = { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } as const;
const timestamp = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
const wakeEvent = { type: "object", additionalProperties: false, required: ["version", "id", "kind", "text", "occurredAt"], properties: { version: { const: "noopolis.daimon.wake.v1" }, id: text, kind: { enum: ["manual", "message", "schedule", "external"] }, text: boundedText, occurredAt: timestamp } } as const;
const wakeResultBase = { version: { const: "noopolis.daimon.wake-result.v1" }, agentId: text, wakeId: text } as const;
const activityItem = { type: "object", additionalProperties: false, required: ["id", "agentId", "kind", "occurredAt"], properties: { id: { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }, agentId: text, wakeId: text, kind: { enum: ["wake_started", "wake_completed", "wake_rejected", "wake_aborted", "agent_stopped"] }, occurredAt: timestamp } } as const;

export const RUNTIME_CONTRACT_MANIFEST = {
  version: RUNTIME_CONTRACT_MANIFEST_VERSION,
  consumedConfigFields: ["version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id", "agents[].name", "agents[].instructions", "agents[].workspacePath", "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].engine.model", "agents[].engine.reasoningEffort", "agents[].engine.codexSandbox", "agents[].schedule.kind", "agents[].schedule.interval_ms", "agents[].schedule.cron", "agents[].schedule.timezone", "agents[].schedule.prompt", "agents[].schedule.jitter_seconds", "agents[].mcp", "agents[].moltnet", "agents[].memory", "agents[].attention", "agents[].recording", "host.maxWakeTextBytes"],
  wakeMoments: WAKE_MOMENTS,
  organizationRuntimeConfigSchema: ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  organizationRuntimeConfigV2Schema: ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  wakeAcceptanceTypes: ["manual", "message", "schedule", "external"],
  deliverySemantics: {
    activeDeliveryIdempotency: "unbounded-until-terminal",
    terminalReceiptHorizon: 2_048,
    recovery: "at-least-once-with-stable-wake-id",
    concurrentSameAgentTurns: false,
    externalEffectsExactlyOnce: false
  },
  attention: { enabledBy: "agents[].attention", defaultMaxBatchMessages: 8, defaultMaxBatchBytes: 12000, idleDispatch: "immediate", busyDispatch: "bounded-pending-message-batch", completion: "explicit-per-delivery", unhandled: "deferred-until-new-input", accounting: "execution-start-reservations" },
  workAvailabilityResponseSchema: WORK_AVAILABILITY_SCHEMA,
  workBlockedSchema: WORK_BLOCKED_SCHEMA,
  operatorDrain: OPERATOR_DRAIN,
  supportedEngineKinds: SORTED_ENGINE_IDS,
  engines: ENGINE_DESCRIPTORS,
  engineCredentialMaterial: ENGINE_CREDENTIAL_MATERIAL,
  codexSubscriptionRealm: CODEX_SUBSCRIPTION_REALM,
  grokSubscriptionRealm: GROK_SUBSCRIPTION_REALM,
  grokEngineBroker: GROK_ENGINE_BROKER,
  agySubscriptionRealm: AGY_SUBSCRIPTION_REALM,
  wakeRequestSchema: { type: "object", additionalProperties: false, required: ["agentId", "event"], properties: { agentId: text, event: wakeEvent } },
  wakeResultSchema: { oneOf: [
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "text", "durationMs"], properties: { ...wakeResultBase, status: { const: "completed" }, text: boundedText, durationMs: { type: "integer", minimum: 0 } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "rejected" }, code: { enum: ["unauthorized", "unknown_agent", "queue_full", "durable_inbox_required"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { version: { const: "noopolis.daimon.wake-result.v1" }, status: { const: "rejected" }, agentId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, wakeId: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, code: { const: "invalid_request" } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "stopped" }, code: { enum: ["host_stopping", "host_stopped", "queued_wake_stopped", "active_wake_aborted"] } } },
    { type: "object", additionalProperties: false, required: ["version", "status", "agentId", "wakeId", "code"], properties: { ...wakeResultBase, status: { const: "failed" }, code: { const: "engine_failed" } } }
  ] },
  healthResponseSchema: { type: "object", additionalProperties: false, required: ["version", "state", "agents"], properties: { version: { const: "noopolis.daimon.organization-runtime-health.v1" }, state: { enum: ["starting", "running", "stopping", "stopped"] }, agents: { type: "array", maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: { type: "object", additionalProperties: false, required: ["agentId", "state"], properties: { agentId: text, state: { enum: ["starting", "running", "stopping", "stopped", "idle", "failed"] } } } } } },
  activityResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: "noopolis.daimon.organization-runtime-activity.v1" }, items: { type: "array", maxItems: 100, items: activityItem }, nextCursor: { type: "string", minLength: 1, maxLength: 16, pattern: "^(0|[1-9][0-9]{0,15})$" } } },
  activityV2ResponseSchema: { type: "object", additionalProperties: false, required: ["version", "items"], properties: { version: { const: ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION }, state: { enum: ["running", "stopped"] }, executions: { type: "array", maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: { type: "object", additionalProperties: false, required: ["agent_id", "execution_id", "state", "delivery_ids"], properties: { agent_id: text, execution_id: { type: "string" }, state: { const: "running" }, delivery_ids: { type: "array", maxItems: 32, items: text } } } }, items: { type: "array", maxItems: 2_112, items: { type: "object", additionalProperties: false, required: ["version", "acceptance_id", "agent_id", "delivery_id", "request_digest", "state", "accepted_at", "updated_at", "active"], properties: { version: { const: "noopolis.daimon.wake-receipt-status.v2" }, acceptance_id: { type: "string" }, agent_id: text, delivery_id: text, request_digest: { type: "string" }, state: { enum: ["accepted", "running", "completed", "failed", "stopped"] }, accepted_at: timestamp, updated_at: timestamp, active: { type: "boolean" }, execution_id: { type: "string" }, deferred: { type: "boolean" }, text: { type: "string", maxLength: 16384 }, queue_position: { type: "integer", minimum: 1 }, code: { enum: ["engine_failed", "host_stopped", "host_stopping", "queued_wake_stopped", "active_wake_aborted", "queue_full", "unknown_agent"] } } } } } }
} as const;
