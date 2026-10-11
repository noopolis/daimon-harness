import { WAKE_MOMENTS } from "./wakeMomentContract.js";
import { OPERATOR_DRAIN, WORK_AVAILABILITY_SCHEMA, WORK_BLOCKED_SCHEMA } from "./attentionContract.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS, GROK_WORKER_MAX_TURNS, GROK_WORKER_TOOL_IDS, GROK_WORKER_VISIBLE_TOOLS } from "./grokWorkerContract.js";
import {
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS
} from "./organizationRuntimeContract.js";

export const RUNTIME_CONTRACT_MANIFEST_VERSION = "noopolis.daimon.runtime-contract-manifest.v3" as const;
export const ORGANIZATION_RUNTIME_ACTIVITY_V2_VERSION = "noopolis.daimon.organization-runtime-activity.v2" as const;
export const ENGINE_CREDENTIAL_MATERIAL = {
  codex: { sourceSlot: "codex-auth", sourceRelativePath: ".daimon-inbound/codex-auth", destinationRelativePath: ".codex/auth.json", directoryMode: 0o700, fileMode: 0o600 }
} as const;
export const GROK_SUBSCRIPTION_REALM = {
  agentCredentialRelativePath: ".grok/auth.json",
  bootstrapMountPath: "/var/lib/spawnfile/daimon/grok-bootstrap-auth",
  bootstrapSourceSlot: "grok-auth",
  directoryMode: 0o700,
  durableMountPath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  fileMode: 0o600,
  maxCredentialBytes: 64 * 1024
} as const;
export const GROK_ENGINE_BROKER = {
  nativeAbiVersion: 2,
  nativeExecutablePath: "/opt/daimon/bin/daimon-engine-broker",
  grokExecutablePath: "/usr/local/bin/grok",
  registrationPath: "/etc/daimon-engine-broker/registrations.bin",
  credentialHomePath: "/var/lib/spawnfile/daimon/grok-subscription-realm",
  turnStorePath: "/var/lib/spawnfile/daimon/grok-subscription-realm/turns",
  controlSocketPath: "/run/daimon-engine-broker/control.sock",
  backendSocketPath: "/run/daimon-engine-broker/backend.sock",
  launcherSocketPath: "/run/daimon-engine-broker/launcher.sock",
  serviceConfigPath: "/etc/daimon-engine-broker/service.json",
  providerProxy: { host: "127.0.0.1", port: 43_123 },
  mcpFacade: { host: "127.0.0.1", port: 43_124, path: "/mcp" },
  identities: { organizationUid: 2_000, brokerUid: 2_100, firstWorkerUid: 2_200 },
  grokCliVersion: "1.0.34",
  grokCliBuild: "3736acbc8658",
  grokCliArtifacts: {
    arm64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-aarch64", sha256: "39ab87666877d64ef3a40aa60fbe0c3b6a6acd7001b78fe60e2c76bb6cfc4a94", bytes: 136_090_504 },
    x64: { url: "https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.34-linux-x86_64", sha256: "be5905e107d2b8b5f3c142d21ecfe4c8fd32a913d2fd551b788707930c4dc80d", bytes: 163_035_648 }
  },
  worker: {
    modelId: "daimon-broker-grok",
    models: GROK_BROKER_MODELS,
    reasoningEfforts: GROK_BROKER_REASONING_EFFORTS,
    defaultModel: "grok-4.6",
    defaultReasoningEffort: "low",
    toolIds: GROK_WORKER_TOOL_IDS,
    visibleTools: GROK_WORKER_VISIBLE_TOOLS,
    maxTurns: GROK_WORKER_MAX_TURNS,
    systemPromptSha256: "2c31c0085a54a4efbf9c0cf0b8124c56e47f38691b7f0c7fa233a74abaa8ddf8",
    // sha256 of `renderGrokBrokerWorkerConfig({ model, reasoningEffort })`, the only accepted config.toml bytes.
    configSha256: {
      "grok-4.6": { low: "ab58499ac32678097c146479896f2b8a8e2b0e39aea22dc0a60b6227e370538e", medium: "df1a5cc84346e7f6bf6090492fbd19faaefb42953e3bb2e8c6cbc0572242403f", high: "65b0212564fb74042b1503d293fb8d3620276033264c0efade2a539ca09218e3" },
      "grok-4.5": { low: "8247127c3625ff7c5d8d527a53596b89ec6557a821ac46cfd00bd122b90daff6", medium: "59288cee61297bb8c002097061a48f77b09d310754187a253ee089f7172a9155", high: "c63c3387ce92d94ec3f690abfe98942afcd7c9e17ff84816bbe751f340ab251f" },
      "grok-build": { low: "fb343f2809903f26d21681470943235031f946e99085542fd89555eb7782cbb5", medium: "8a587ef75c90eab70d19b24583e60051d6fba9d90c558839fdbb15588b4cc656", high: "a23724e00d670caee185ba7690d2daa868173e53905cf446f5329666f01ab4e3" }
    },
    // Worker `GROK_HOME` layout the broker attests before every turn. The home and
    // its `sessions/` directory are root-owned, worker-group writable and sticky so
    // Grok can create its own state but never replace a root-owned file.
    home: {
      directory: { uid: 0, group: "worker", mode: 0o1771 },
      sessionsDirectory: { relativePath: "sessions", uid: 0, group: "worker", mode: 0o1771 },
      readOnlyFiles: { names: ["config.toml", "managed_config.toml", "requirements.toml", "sandbox.toml", "trusted_folders.toml"], uid: 0, gid: 0, mode: 0o444 },
      sandboxEvents: { relativePath: "sessions/sandbox-events.jsonl", owner: "worker", group: "broker", mode: 0o640 },
      // The launcher exports TMPDIR=<worker home>/tmp; Grok's strict profile grants TMPDIR read-write.
      privateTmp: { relativeToWorkerHome: "tmp", owner: "worker", mode: 0o700 },
      // Strict also grants shared /tmp and /var/tmp read-write and refuses to start if either is
      // denied, so the deployment keeps them from every worker by mode: root-owned, a non-worker
      // group (< 2200), others read-only (Grok needs to open the directory) and no search/write.
      sharedTmp: { paths: ["/tmp", "/var/tmp"], uid: 0, maxGroupExclusive: 2_200, otherMode: 0o4, mode: 0o1774 },
      // The organization runtime home of a brokered Grok agent: traverse-only for the
      // worker group so the worker can reach `tool-output/` and nothing else (no group
      // read, no group write, no world bits; `physicalReadiness.ts` refuses anything else).
      organizationRuntimeHome: { owner: "organization", group: "worker", mode: 0o710 },
      // Spilled tool output the worker reads with read_file: setgid directory in the worker's group,
      // files written 0640 by the runtime, never other-readable.
      spillDirectory: { relativeToRuntimeHome: "tool-output", owner: "organization", group: "worker", mode: 0o2750, fileMode: 0o640 }
    }
  },
  bounds: { promptBytes: 65_536, capabilityBytes: 4_096, capabilityBundleBytes: 8_196, outputBytes: 262_144 },
  // Accounting and limits (P2). The broker is the single sealed usage writer.
  controlProtocolVersion: "noopolis.daimon.engine-broker.v2",
  turnRecordVersions: ["noopolis.daimon.engine-broker-turn.v1", "noopolis.daimon.engine-broker-turn.v2"],
  serviceConfigVersions: ["noopolis.daimon.engine-broker-service.v1", "noopolis.daimon.engine-broker-service.v2"],
  turnLimits: {
    keys: ["maxRequests", "maxTokens", "timeoutMs"],
    v1Defaults: { maxRequests: 32, maxTokens: 300_000, timeoutMs: 240_000 },
    bounds: { maxRequests: [1, GROK_WORKER_MAX_TURNS], maxTokens: [1, 10_000_000], timeoutMs: [1_000, 3_600_000] },
    limitReasons: ["tokens", "requests", "timeout", "none"],
    wakeMayOnlyLower: true,
    tokenCeilingOvershoot: "at-most-one-request",
    maxInFlightRequests: 1,
    // A per-request usage block above this is implausible (beyond the model
    // context window) and treated as invalid rather than added to any total.
    requestUsageMaxTokens: 500_000,
    // A request whose response carries no valid usage is charged this estimate.
    missingUsageEstimate: { inputBytesPerToken: 2, outputTokens: 4_096 }
  },
  wakeLimitEnvironment: { timeoutMs: "DAIMON_ENGINE_WAKE_TIMEOUT_MS", maxTokens: "DAIMON_ENGINE_WAKE_TOKEN_CEILING" },
  // Evaluator inference grants (P2c). Judges and the optimizer (organization uid
  // only, over the control socket) borrow the broker's Grok credential through
  // the provider proxy; they never hold it, and their spend never reaches the
  // subject usage ledger or wake fuse.
  inferenceGrants: {
    requestKinds: ["request_inference_grant", "release_inference_grant"],
    purposes: ["judge", "optimizer"],
    tokenPrefix: "inference_",
    ttlMs: 600_000,
    limits: { maxRequests: 64, maxTokens: 2_000_000 },
    maxLiveGrants: 8,
    maxInFlightRequestsPerGrant: 1,
    // Top-level request members Grok 1.0.34 sends for a Paideia judge/optimizer call
    // (live stub capture); `tools` and `tool_choice` are refused outright.
    bodyMembers: ["messages", "model", "reasoning_effort", "response_format", "stream", "stream_options"],
    messageRoles: ["system", "user", "assistant"],
    failureCodes: ["auth_stale", "grant_limit", "invalid_request", "unavailable"],
    ledgerVersion: "noopolis.daimon.inference-usage.v1",
    ledgerDedupeKey: ["grant", "request"],
    client: {
      modelId: "daimon-inference-grok",
      envKey: "DAIMON_INFERENCE_GRANT",
      // sha256 of `renderGrokInferenceClientConfig` for the production proxy base URL and this env key.
      configSha256: {
        "grok-4.6": { low: "79314d039f787e4ebfec7dacf57adc969086b948f564dec008f0ed6367e6062f", medium: "6f538de0547c0c4e6a3f04ae08595ceadadabb06b75f6b6ee4c428744bb95cd8", high: "5652656effa82f0c4f09cf8226b16e6140332a5a358b571194bb5563312367ac" },
        "grok-4.5": { low: "a07f7436f1268bb399ec233c65d3b3d8fb99a11a1f175f8da1ca133c9367bc74", medium: "1f4c0d4dad1f3b09419b5739db6423a09e0049abc091594c64123a75dd53dfb9", high: "ffbc33728b821e9854fbc7c93601e599225da421ecfd6ebf10d314afcc28d6f2" },
        "grok-build": { low: "ca15c6a562a008227d39c51d3a3a83715663089b3784e8b46debb1fb67b3c4a1", medium: "01783fb6beadcf6f8486fff0836820ad43fab5662b812a907fe9cfdb83e9804d", high: "98d16f2b7d12f4eb540d625c853e51d227933e204923e43e8b9b4176f10aca2c" }
      }
    }
  },
  projectionVersion: "noopolis.daimon.grok-broker-projection.v1",
  slotPreflightVersion: "noopolis.daimon.grok-slot-preflight.v2",
  artifacts: {
    sourceSha256: "15836d7ad69f12ef581a6e5b8635c9db43b2177dac609160c0749d3d1fefbaa8",
    x64Sha256: "95aa9c272225e74ff9f45f54dde4bc30aee324e9ba24d8a876db9151c81b454d",
    arm64Sha256: "d0dc1c03197c3e90f09b66ad7c89b4f7b448d06dc84c03b247dce976d6018d6e"
  }
} as const;
export const AGY_SUBSCRIPTION_REALM = {
  durableMountPath: "/var/lib/spawnfile/daimon/agy-subscription-realm",
  unlockMountPath: "/var/lib/spawnfile/daimon/agy-unlock-secret",
  unlockSourceSlot: "agy-unlock-secret",
  directoryMode: 0o700,
  fileMode: 0o600,
  maxUnlockBytes: 4_096
} as const;

const text = { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" } as const;
const boundedText = { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } as const;
const timestamp = { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" } as const;
const wakeEvent = { type: "object", additionalProperties: false, required: ["version", "id", "kind", "text", "occurredAt"], properties: { version: { const: "noopolis.daimon.wake.v1" }, id: text, kind: { enum: ["manual", "message", "schedule", "external"] }, text: boundedText, occurredAt: timestamp } } as const;
const wakeResultBase = { version: { const: "noopolis.daimon.wake-result.v1" }, agentId: text, wakeId: text } as const;
const activityItem = { type: "object", additionalProperties: false, required: ["id", "agentId", "kind", "occurredAt"], properties: { id: { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }, agentId: text, wakeId: text, kind: { enum: ["wake_started", "wake_completed", "wake_rejected", "wake_aborted", "agent_stopped"] }, occurredAt: timestamp } } as const;

export const RUNTIME_CONTRACT_MANIFEST = {
  version: RUNTIME_CONTRACT_MANIFEST_VERSION,
  consumedConfigFields: ["version", "host.bindHost", "host.port", "host.controlTokenEnv", "agents[].id", "agents[].name", "agents[].instructions", "agents[].workspacePath", "agents[].runtimeHomePath", "agents[].engine.kind", "agents[].engine.model", "agents[].engine.reasoningEffort", "agents[].engine.codexSandbox", "agents[].schedule.kind", "agents[].schedule.interval_ms", "agents[].schedule.cron", "agents[].schedule.timezone", "agents[].schedule.prompt", "agents[].schedule.jitter_seconds", "agents[].mcp", "agents[].moltnet", "agents[].memory", "agents[].attention", "agents[].recording"],
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
  supportedEngineKinds: ["agy", "codex", "grok"],
  engineCredentialMaterial: ENGINE_CREDENTIAL_MATERIAL,
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
