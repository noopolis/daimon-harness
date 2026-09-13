export type AgentId = string;

export interface AgentStartInput {
  id: AgentId;
  name: string;
  instructions: string;
  workspacePath: string;
  runtimeHomePath: string;
  /** Trusted host causal identity, fixed per instance; unsupported with memory until its public API accepts context. */
  causalRunId?: string;
  tools?: string[];
}

export interface HarnessModelEndpoint {
  baseUrl: string;
  compatibility: "anthropic" | "openai";
}

export interface HarnessModelSpec {
  auth?: {
    keyEnv?: string;
    method: "api_key" | "claude-code" | "codex" | "none";
  };
  endpoint?: HarnessModelEndpoint;
  name: string;
  provider: string;
}

export interface WakeDeliveryMetadata {
  eventId: string;
  sender: string;
  target: string;
  contextId: string;
}

export interface WakeEvent {
  id: string;
  kind: "manual" | "message" | "schedule" | "dream";
  from?: string;
  text: string;
  context?: {
    networkId?: string;
    roomId?: string;
    teamId?: string;
    taskId?: string;
    roleId?: string;
    from?: string;
    pairPeers?: string[];
    artifactPaths?: string[];
  };
  delivery?: WakeDeliveryMetadata;
  /** Exact transport body retained outside the runtime-enriched model prompt. */
  transportText?: string;
}

export interface WakeResult {
  agentId: AgentId;
  text: string;
  durationMs: number;
}

export interface AgentStatus {
  agentId: AgentId;
  state: "starting" | "idle" | "running" | "stopped" | "failed";
  lastWakeAt?: string;
  lastError?: string;
}

export interface AgentHandle {
  id: AgentId;
  wake(event: WakeEvent): Promise<WakeResult>;
  status(): AgentStatus;
  stop(): Promise<void>;
}

export interface AgentHarnessAdapter {
  startAgent(input: AgentStartInput): Promise<AgentHandle>;
}
