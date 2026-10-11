import type { AttentionRegistry } from "./attention.js";
import { consumeDurableAdmission, registerRecordingVerifier } from "./organizationRuntimeAdmission.js";
import { readTaskClock, taskClockChildEnvironment } from "./taskClock.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AgentHandle, AgentStatus, WakeEvent } from "../core/types.js";
import { sanitizeWakeCompletionText } from "./wakeAcceptanceTypes.js";
import { startOrganizationRuntimeEngine } from "./engineDispatcher.js";
import type { OrganizationRuntimePathAuthority } from "./physicalReadiness.js";
import {
  prepareProductionReadiness,
  type OrganizationRuntimeHostReadiness
} from "./organizationRuntimeReadiness.js";
import {
  parseOrganizationRuntimeConfig,
  parseOrganizationRuntimeWakeRequest,
  type OrganizationRuntimeActivity,
  type OrganizationRuntimeActivityPage,
  type OrganizationRuntimeActivityRequest,
  type OrganizationRuntimeAgentConfig,
  type OrganizationRuntimeAgentHealth,
  type OrganizationRuntimeConfig,
  type OrganizationRuntimeHealth,
  type OrganizationRuntimeHost,
  type OrganizationRuntimeLifecycleState,
  type OrganizationRuntimeShutdownCompletion,
  type OrganizationRuntimeWakeRequest,
  type OrganizationRuntimeWakeResult
} from "./organizationRuntime.js";
type OrganizationRuntimeEngineFactory = (
  agent: OrganizationRuntimeAgentConfig,
  paths?: ReturnType<OrganizationRuntimePathAuthority["forAgent"]>
) => Promise<AgentHandle>;
type HostReadiness = OrganizationRuntimeHostReadiness;
type ProductionHostOptions = Readonly<{ sharedProtectedPaths?: readonly string[] }>;
type WakeJob = {
  readonly request: OrganizationRuntimeWakeRequest;
  readonly resolve: (result: OrganizationRuntimeWakeResult) => void;
  settled: boolean;
  aborting: boolean;
};
type HostedAgent = {
  readonly config: OrganizationRuntimeAgentConfig;
  handle?: AgentHandle;
  state: OrganizationRuntimeAgentHealth["state"];
  active?: WakeJob;
  draining: boolean;
  pending: WakeJob[];
  stopped: boolean;
};
/** Creates the public host with Daimon's closed production engine dispatcher. */
export function createOrganizationRuntimeHost(config: unknown, options: ProductionHostOptions = {}): OrganizationRuntimeHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  if (parsed.agents.some((agent) => agent.attention !== undefined)) throw new Error("attention requires createOrganizationRuntimeControlHost and POST /v2/wakes for durable inbox ownership");
  return createOrganizationRuntimeHostWithAttention(parsed, options, new Map());
}
/** @internal Control-owned attention registry, never a caller-supplied config hook. */
export function createOrganizationRuntimeHostWithAttention(config: unknown, options: ProductionHostOptions, attention: AttentionRegistry): OrganizationRuntimeHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  let agyBusAddress: string | undefined;
  let grokBroker: OrganizationRuntimeHostReadiness["grokBroker"];
  return createHost(
    parsed,
    (agent, paths) => startOrganizationRuntimeEngine(agent, parsed.host.controlTokenEnv, paths, agyBusAddress, grokBroker, parsed.agents, options.sharedProtectedPaths, attention),
    async () => {
      const ready = await prepareProductionReadiness(parsed);
      agyBusAddress = ready.agyRealm?.busAddress;
      grokBroker = ready.grokBroker;
      return {
        ...ready,
        async close() {
          try { await ready.close(); } finally { agyBusAddress = undefined; grokBroker = undefined; }
        }
      };
    }
  );
}

/** @internal Test-only construction seam; it is intentionally not package-exported. */
export function createOrganizationRuntimeHostForTest(
  config: unknown,
  factory: OrganizationRuntimeEngineFactory,
  preflight?: () => Promise<OrganizationRuntimePathAuthority>
): OrganizationRuntimeHost {
  return createHost(parseOrganizationRuntimeConfig(config), factory, preflight === undefined ? undefined : async () => {
    const paths = await preflight();
    return { paths, close: () => paths.close() };
  });
}

function createHost(
  config: OrganizationRuntimeConfig,
  factory: OrganizationRuntimeEngineFactory,
  preflight: (() => Promise<HostReadiness>) | undefined = undefined
): OrganizationRuntimeHost {
  const maxPendingWakes = 64;
  const maxActivity = 512;
  const agents = new Map<string, HostedAgent>(config.agents.map((agent): [string, HostedAgent] => [agent.id, {
    config: agent,
    state: "stopped",
    draining: false,
    pending: [],
    stopped: false
  }]));
  const activity: Array<{ sequence: number; value: OrganizationRuntimeActivity }> = [];
  let nextActivitySequence = 0;
  // Capture the expected token before any operation can route by agent id.
  const controlToken = process.env[config.host.controlTokenEnv];
  let state: OrganizationRuntimeLifecycleState = "stopped";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<OrganizationRuntimeShutdownCompletion> | undefined;
  let stopRequested = false;
  let readiness: HostReadiness | undefined;

  const addActivity = (agentId: string, kind: OrganizationRuntimeActivity["kind"], wakeId?: string): void => {
    activity.push({
      sequence: nextActivitySequence++,
      value: { id: randomUUID(), agentId, ...(wakeId === undefined ? {} : { wakeId }), kind, occurredAt: new Date().toISOString() }
    });
    if (activity.length > maxActivity) activity.shift();
  };

  const stoppedResult = (request: OrganizationRuntimeWakeRequest, code: Extract<OrganizationRuntimeWakeResult, { status: "stopped" }>["code"]): OrganizationRuntimeWakeResult => ({
    version: "noopolis.daimon.wake-result.v1",
    status: "stopped",
    agentId: request.agentId,
    wakeId: request.event.id,
    code
  });

  const settle = (job: WakeJob, result: OrganizationRuntimeWakeResult): void => {
    if (job.settled) return;
    job.settled = true;
    job.resolve(result);
  };

  const drain = async (agent: HostedAgent): Promise<void> => {
    if (agent.draining) return;
    agent.draining = true;
    try {
      while (state === "running" && agent.pending.length > 0) {
        const job = agent.pending.shift();
        if (job === undefined) continue;
        agent.active = job;
        agent.state = "running";
        addActivity(agent.config.id, "wake_started", job.request.event.id);
        try {
          const result = await agent.handle!.wake(toCoreWake(job.request));
          if (!job.settled && !job.aborting) {
            agent.state = "idle";
            addActivity(agent.config.id, "wake_completed", job.request.event.id);
            settle(job, completed(job.request, result.text, result.durationMs));
          }
        } catch (error) {
          if (!job.settled && !job.aborting) {
            agent.state = "failed";
            settle(job, failed(job.request, error));
          }
        } finally {
          if (agent.active === job) agent.active = undefined;
        }
      }
    } finally {
      agent.draining = false;
    }
  };

  const start = async (): Promise<void> => {
    if (state === "running") return;
    if (startPromise !== undefined) return startPromise;
    if (stopRequested) throw new Error("organization runtime host has been stopped");
    const clock = readTaskClock();
    for (const agent of config.agents) for (const server of agent.mcp ?? []) taskClockChildEnvironment(server.env, clock);
    if (controlToken === undefined || !controlToken.trim()) {
      throw new Error(`required control token ${config.host.controlTokenEnv} is missing or blank`);
    }
    state = "starting";
    for (const agent of agents.values()) agent.state = "starting";
    startPromise = (async () => {
      // This runs before a factory can create an adapter or child process.
      try {
        readiness = await preflight?.();
      } catch (error) {
        state = "stopped";
        for (const agent of agents.values()) agent.state = "stopped";
        throw error;
      }
      const started = await Promise.allSettled([...agents.values()].map(async (agent) => {
        const paths = readiness?.paths.forAgent(agent.config);
        await paths?.verify();
        agent.handle = await factory(agent.config, paths);
        await paths?.verify();
        return agent;
      }));
      const failedStart = started.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedStart !== undefined || stopRequested) {
        state = "stopping";
        stopRequested = true;
        const startedAgents = [...agents.values()].filter((agent) => agent.handle !== undefined);
        const stopped = await Promise.allSettled(startedAgents.map(async (agent) => {
          await agent.handle!.stop();
          agent.handle = undefined;
          agent.stopped = true;
          agent.state = "stopped";
        }));
        const cleanupFailures = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        for (const agent of agents.values()) {
          if (agent.handle !== undefined) agent.state = "stopping";
          else if (!agent.stopped) agent.state = "stopped";
        }
        if (cleanupFailures.length > 0) {
          // A handle that cannot stop remains visible and retryable.
          state = "stopping";
          throw new AggregateError([...(failedStart === undefined ? [] : [failedStart.reason]), ...cleanupFailures], "organization runtime startup cleanup failed");
        }
        await readiness?.close();
        readiness = undefined;
        state = "stopped";
        if (failedStart !== undefined) throw failedStart.reason;
        return;
      }
      try {
        state = "running";
        for (const agent of agents.values()) agent.state = "idle";
      } catch (error) {
        state = "stopping";
        await Promise.allSettled([...agents.values()].flatMap((agent) => agent.handle === undefined ? [] : [agent.handle.stop()]));
        await readiness?.close(); readiness = undefined;
        for (const agent of agents.values()) { agent.handle = undefined; agent.state = "stopped"; }
        state = "stopped";
        throw error;
      }
    })().finally(() => {
      startPromise = undefined;
    });
    return startPromise;
  };

  const wake = async (request: OrganizationRuntimeWakeRequest): Promise<OrganizationRuntimeWakeResult> => {
    const durable = consumeDurableAdmission(request);
    let parsed: OrganizationRuntimeWakeRequest;
    try {
      parsed = parseOrganizationRuntimeWakeRequest(request);
    } catch {
      return invalidRequest();
    }
    if (controlToken === undefined || !tokensEqual(controlToken, parsed.token)) {
      return rejected(parsed, "unauthorized");
    }
    if (state !== "running" || stopRequested) {
      return stoppedResult(parsed, stopRequested || state === "stopping" ? "host_stopping" : "host_stopped");
    }
    const agent = agents.get(parsed.agentId);
    if (agent === undefined) {
      addActivity(parsed.agentId, "wake_rejected", parsed.event.id);
      return rejected(parsed, "unknown_agent");
    }
    if (agent.config.recording && !durable) return rejected(parsed, "durable_inbox_required");
    if (agent.pending.length >= maxPendingWakes) {
      addActivity(parsed.agentId, "wake_rejected", parsed.event.id);
      return rejected(parsed, "queue_full");
    }
    return new Promise<OrganizationRuntimeWakeResult>((resolve) => {
      const job: WakeJob = { request: parsed, resolve, settled: false, aborting: false };
      agent.pending.push(job);
      void drain(agent);
    });
  };

  const health = async (agentId?: string): Promise<OrganizationRuntimeHealth> => ({
    version: "noopolis.daimon.organization-runtime-health.v1",
    state,
    agents: [...agents.values()]
      .filter((agent) => agentId === undefined || agent.config.id === agentId)
      .map((agent) => ({ agentId: agent.config.id, engine: agent.config.engine.kind, state: agentHealthState(agent) }))
  });

  const activityPage = async (request: OrganizationRuntimeActivityRequest): Promise<OrganizationRuntimeActivityPage> => {
    const offset = cursorOffset(request.cursor);
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new TypeError("activity.limit must be an integer between 1 and 100");
    }
    const filtered = activity.filter((entry) => entry.sequence >= offset
      && (request.agentId === undefined || entry.value.agentId === request.agentId));
    const entries = filtered.slice(0, request.limit);
    const items = entries.map((entry) => entry.value);
    const next = entries.length === 0 ? undefined : entries[entries.length - 1]!.sequence + 1;
    return {
      version: "noopolis.daimon.organization-runtime-activity.v1",
      items,
      ...(next !== undefined && filtered.length > entries.length ? { nextCursor: String(next) } : {})
    };
  };

  const stop = (): Promise<OrganizationRuntimeShutdownCompletion> => {
    if (stopPromise !== undefined) return stopPromise;
    stopRequested = true;
    const attempt: Promise<OrganizationRuntimeShutdownCompletion> = (async () => {
      if (startPromise !== undefined) await startPromise.catch(() => undefined);
      if (state === "stopped") return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" };
      state = "stopping";
      const active: Array<{ agent: HostedAgent; job: WakeJob }> = [];
      for (const agent of agents.values()) {
        for (const job of agent.pending.splice(0)) settle(job, stoppedResult(job.request, "queued_wake_stopped"));
        if (agent.active !== undefined) {
          agent.active.aborting = true;
          active.push({ agent, job: agent.active });
        }
      }
      const liveAgents = [...agents.values()].filter((agent) => agent.handle !== undefined && !agent.stopped);
      const stopped = await Promise.allSettled(liveAgents.map(async (agent) => {
        await agent.handle!.stop();
        agent.handle = undefined;
        agent.stopped = true;
        agent.state = "stopped";
      }));
      const failures = stopped.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      for (const { agent, job } of active) {
        addActivity(agent.config.id, "wake_aborted", job.request.event.id);
        settle(job, stoppedResult(job.request, "active_wake_aborted"));
      }
      if (failures.length > 0) {
        for (const agent of liveAgents) if (agent.handle !== undefined) agent.state = "stopping";
        throw new AggregateError(failures, "organization runtime shutdown cleanup failed");
      }
      await readiness?.close();
      readiness = undefined;
      for (const agent of agents.values()) agent.stopped = true;
      for (const agent of agents.values()) {
        agent.state = "stopped";
        addActivity(agent.config.id, "agent_stopped");
      }
      state = "stopped";
      return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" };
    })();
    stopPromise = attempt;
    void attempt.catch(() => { if (stopPromise === attempt) stopPromise = undefined; });
    return attempt;
  };

  return registerRecordingVerifier({ start, wake, health, activity: activityPage, stop }, async (id) => {
    await readiness?.paths.forAgent(agents.get(id)!.config).verifyRecording?.();
  });
}

function toCoreWake(request: OrganizationRuntimeWakeRequest): WakeEvent {
  return {
    id: request.event.id, kind: request.event.kind === "external" ? "manual" : request.event.kind, text: request.event.text
  };
}
function agentHealthState(agent: HostedAgent): OrganizationRuntimeAgentHealth["state"] {
  const status: AgentStatus | undefined = agent.handle?.status();
  return agent.state === "running" || agent.state === "failed" || agent.state === "stopped"
    ? agent.state
    : status?.state ?? agent.state;
}

function tokensEqual(expected: string, actual: string | undefined): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(actual ?? ""));
}

function cursorOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^(0|[1-9][0-9]{0,15})$/.test(cursor)) throw new TypeError("activity.cursor is invalid");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new TypeError("activity.cursor is invalid");
  return offset;
}

function completed(request: OrganizationRuntimeWakeRequest, text: string, durationMs: number): OrganizationRuntimeWakeResult {
  return { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: request.agentId, wakeId: request.event.id, text: sanitizeWakeCompletionText(text), durationMs };
}

/** Engine failures are undiagnosable without the cause, so carry a bounded excerpt. */
export const ENGINE_FAILURE_DETAIL_MAX_BYTES = 2_048;

function failed(request: OrganizationRuntimeWakeRequest, error?: unknown): OrganizationRuntimeWakeResult {
  const detail = engineFailureDetail(error);
  return { version: "noopolis.daimon.wake-result.v1", status: "failed", agentId: request.agentId, wakeId: request.event.id, code: "engine_failed", ...(detail === undefined ? {} : { detail }) };
}

export function engineFailureDetail(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (raw === undefined) return undefined;
  const trimmed = raw.replaceAll(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return undefined;
  return Buffer.from(trimmed, "utf8").subarray(0, ENGINE_FAILURE_DETAIL_MAX_BYTES).toString("utf8");
}

function rejected(request: OrganizationRuntimeWakeRequest, code: "unauthorized" | "unknown_agent" | "queue_full" | "durable_inbox_required"): OrganizationRuntimeWakeResult {
  return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code };
}

function invalidRequest(): OrganizationRuntimeWakeResult {
  return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "", wakeId: "", code: "invalid_request" };
}
