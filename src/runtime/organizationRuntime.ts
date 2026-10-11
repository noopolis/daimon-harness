import type { AttentionConfig } from "../contracts/attentionContract.js";
import type { WakeMomentRecording } from "../contracts/wakeMomentContract.js";
export type { WakeMomentRecording } from "../contracts/wakeMomentContract.js";
import {
  ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS,
  ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY,
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES,
  ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS,
  ORGANIZATION_RUNTIME_V2_VERSION,
  ORGANIZATION_RUNTIME_VERSION
} from "../contracts/organizationRuntimeContract.js";

export {
  ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS,
  ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY,
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES,
  ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS,
  ORGANIZATION_RUNTIME_V2_VERSION,
  ORGANIZATION_RUNTIME_VERSION
};

export type OrganizationRuntimeEngineKind = "codex" | "grok" | "agy";
/**
 * `model`/`reasoningEffort` are accepted for codex (open model name) and for
 * grok (closed broker lists, declared together); agy owns its own model
 * selection and `organizationRuntimeParsing.ts` rejects either field there at
 * parse time rather than silently ignoring it. The type stays flat
 * — not a `kind`-discriminated union — because every parsed value already
 * satisfies the invariant; callers that need it narrow on `kind === "codex"`.
 */
export type OrganizationRuntimeCodexSandboxPolicy = Readonly<{ mode: "workspace-write"; networkAccess: false; webSearch: "disabled" }>;
export type OrganizationRuntimeEngineIntent = Readonly<{ kind: OrganizationRuntimeEngineKind; model?: string; reasoningEffort?: string; codexSandbox?: OrganizationRuntimeCodexSandboxPolicy }>;
export type OrganizationRuntimeMcpServer = Readonly<{ name: string; transport: "stdio" | "sse" | "streamable_http"; command?: string; args: readonly string[]; env: Readonly<Record<string, string>>; authSecretEnv?: string; url?: string; tools: readonly string[] }>;
export type OrganizationRuntimeMoltnet = Readonly<{ cliPath: string; configPath: string; networks: readonly Readonly<{ id: string; rooms: readonly string[]; dms: boolean }>[] }>;
export type OrganizationRuntimeMemory = Readonly<{ runtimeHomePath: string; source?: string; tokenBudget?: number }>;
export type OrganizationRuntimeSchedule =
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "every"; interval_ms: number; prompt: string; jitter_seconds?: number }>
  | Readonly<{ kind: "cron"; cron: string; timezone: string; prompt: string; jitter_seconds?: number }>;
export type OrganizationRuntimeAgentConfig = Readonly<{ id: string; name: string; instructions: string; workspacePath: string; runtimeHomePath: string; engine: OrganizationRuntimeEngineIntent; attention?: AttentionConfig; recording?: WakeMomentRecording; schedule?: OrganizationRuntimeSchedule; mcp?: readonly OrganizationRuntimeMcpServer[]; moltnet?: OrganizationRuntimeMoltnet; memory?: OrganizationRuntimeMemory }>;
export type OrganizationRuntimeHostConfig = Readonly<{ bindHost: string; port: number; /** Variable name only; never secret configuration data. */ controlTokenEnv: string }>;
export type OrganizationRuntimeConfig = Readonly<{ version: typeof ORGANIZATION_RUNTIME_VERSION | typeof ORGANIZATION_RUNTIME_V2_VERSION; host: OrganizationRuntimeHostConfig; agents: readonly OrganizationRuntimeAgentConfig[] }>;
export type OrganizationRuntimeLifecycleState = "starting" | "running" | "stopping" | "stopped";
export type OrganizationRuntimeWakeEvent = Readonly<{ version: "noopolis.daimon.wake.v1"; id: string; kind: "manual" | "message" | "schedule" | "external"; text: string; occurredAt: string }>;
export type OrganizationRuntimeWakeRequest = Readonly<{ token: string | undefined; agentId: string; event: OrganizationRuntimeWakeEvent }>;
export type OrganizationRuntimeWakeResult =
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "completed"; agentId: string; wakeId: string; text: string; durationMs: number }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "rejected"; agentId: string; wakeId: string; code: "invalid_request" | "unauthorized" | "unknown_agent" | "queue_full" | "durable_inbox_required" }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "stopped"; agentId: string; wakeId: string; code: "host_stopping" | "host_stopped" | "queued_wake_stopped" | "active_wake_aborted" }>
  | Readonly<{ version: "noopolis.daimon.wake-result.v1"; status: "failed"; agentId: string; wakeId: string; code: "engine_failed"; detail?: string }>;
export type OrganizationRuntimeAgentHealth = Readonly<{ agentId: string; engine: OrganizationRuntimeEngineIntent["kind"]; state: OrganizationRuntimeLifecycleState | "idle" | "running" | "failed" }>;
export type OrganizationRuntimeHealth = Readonly<{ version: "noopolis.daimon.organization-runtime-health.v1"; state: OrganizationRuntimeLifecycleState; agents: readonly OrganizationRuntimeAgentHealth[] }>;
export type OrganizationRuntimeActivityRequest = Readonly<{ agentId?: string; cursor?: string; limit: number }>;
export type OrganizationRuntimeActivity = Readonly<{ id: string; agentId: string; wakeId?: string; kind: "wake_started" | "wake_completed" | "wake_rejected" | "wake_aborted" | "agent_stopped"; occurredAt: string }>;
export type OrganizationRuntimeActivityPage = Readonly<{ version: "noopolis.daimon.organization-runtime-activity.v1"; items: readonly OrganizationRuntimeActivity[]; nextCursor?: string }>;
export type OrganizationRuntimeShutdownCompletion = Readonly<{ version: "noopolis.daimon.organization-runtime-stop.v1"; state: "stopped" }>;

/** One host runs isolated agents; it never coordinates their work. */
export interface OrganizationRuntimeHost {
  start(): Promise<void>;
  wake(request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult>;
  health(agentId?: string): Promise<OrganizationRuntimeHealth>;
  activity(request: OrganizationRuntimeActivityRequest): Promise<OrganizationRuntimeActivityPage>;
  stop(): Promise<OrganizationRuntimeShutdownCompletion>;
}

export {
  isOrganizationRuntimeConfig,
  parseOrganizationRuntimeConfig,
  parseOrganizationRuntimeWakeRequest,
  validateOrganizationRuntimeConfig
} from "./organizationRuntimeParsing.js";
