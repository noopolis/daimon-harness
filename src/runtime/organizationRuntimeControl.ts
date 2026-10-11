import { createHash, timingSafeEqual } from "node:crypto";
import { readTaskClock } from "./taskClock.js";
import { parseOrganizationRuntimeConfig, parseOrganizationRuntimeWakeRequest, type OrganizationRuntimeConfig, type OrganizationRuntimeHost, type OrganizationRuntimeShutdownCompletion } from "./organizationRuntime.js";
import { createOrganizationRuntimeHostWithAttention } from "./organizationRuntimeHost.js";
import { WakeFuse, type WakeBudgetSnapshot } from "./wakeFuse.js";
import { AttentionDispatcher } from "./attentionDispatcher.js";
import type { AttentionRegistry } from "./attention.js";
import { createScheduleController, type ScheduleController, type ScheduleControllerOptions } from "./schedule.js";
import { WakeAcceptanceConflictError, WakeAcceptanceStore, WakeInboxFullError, publicAcceptance, type WakeAcceptanceStoreTestOptions } from "./wakeAcceptanceStore.js";
import { parseWakeAcceptanceRequest, ACTIVITY_V2_VERSION, type OrganizationRuntimeActivityV2, type OrganizationRuntimeWakeAcceptanceResult, type OrganizationRuntimeWakeReceiptStatus } from "./wakeAcceptanceTypes.js";

type BlockReason = "operator_stop" | "ledger_unavailable" | "host_stopping" | "host_stopped" | "queue_full";
export type WorkDrain = Readonly<{ state: "draining" | "drained"; since: string }>;
export type WorkAvailability = Readonly<{ version: "noopolis.daimon.work-availability.v1"; state: "running" | "paused" | "stopped"; agents: readonly Readonly<{ agent_id: string; pending: number; running: boolean; deferred: number; budget: WakeBudgetSnapshot; error?: string }>[]; drain?: WorkDrain }>;
export type OrganizationRuntimeControlHost = OrganizationRuntimeHost & Readonly<{
  accept(request: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult>;
  wakeReceipt(token: string | undefined, acceptanceId: string): Promise<OrganizationRuntimeWakeReceiptStatus | undefined>;
  activityV2(token: string | undefined): Promise<OrganizationRuntimeActivityV2 | undefined>;
  availability(token: string | undefined): Promise<WorkAvailability | undefined>;
  /** Reversible operator drain: new wakes answer work-blocked, queued ones stay durable, running turns finish. */
  drain(token: string | undefined): Promise<WorkAvailability | undefined>;
  /** Ends a drain and dispatches the queue. Never clears the latched `fuse.stop`. */
  resume(token: string | undefined): Promise<WorkAvailability | undefined>;
}>;
export type OrganizationRuntimeControlOptions = Readonly<{ acceptanceStorePath: string; controlToken?: string }>;
type TestControlOptions = OrganizationRuntimeControlOptions & Readonly<{
  scheduleOptions?: Pick<ScheduleControllerOptions, "clearTimer" | "now" | "setTimer">;
  storeOptions?: WakeAcceptanceStoreTestOptions;
  fuseEnvironment?: NodeJS.ProcessEnv;
  fusePollIntervalMsForTest?: number;
  attentionRegistryForTest?: AttentionRegistry;
}>;

/** Durable acceptance owns inbox delivery; only dispatch owns execution admission. */
export function createOrganizationRuntimeControlHost(config: unknown, options: OrganizationRuntimeControlOptions): OrganizationRuntimeControlHost {
  const parsed = parseOrganizationRuntimeConfig(config);
  const registry: AttentionRegistry = new Map();
  return createControl(parsed, createOrganizationRuntimeHostWithAttention(parsed, { sharedProtectedPaths: [options.acceptanceStorePath] }, registry), options, registry);
}
/** @internal Test seam; intentionally absent from the public runtime barrel. */
export function createOrganizationRuntimeControlHostWithCoreForTest(config: unknown, host: OrganizationRuntimeHost, options: TestControlOptions): OrganizationRuntimeControlHost {
  return createControl(parseOrganizationRuntimeConfig(config), host, { ...options, fuseEnvironment: options.fuseEnvironment ?? { DAIMON_WAKE_FUSE: "off" } }, options.attentionRegistryForTest ?? new Map());
}

function createControl(config: OrganizationRuntimeConfig, host: OrganizationRuntimeHost, options: TestControlOptions, registry: AttentionRegistry): OrganizationRuntimeControlHost {
  const expectedToken = options.controlToken ?? process.env[config.host.controlTokenEnv];
  const knownAgents = new Set(config.agents.map((agent) => agent.id));
  const persistence = new Set<Promise<unknown>>();
  let store: WakeAcceptanceStore | undefined;
  let schedules: ScheduleController | undefined;
  let fuse: WakeFuse | undefined;
  let dispatcher: AttentionDispatcher | undefined;
  let fusePoll: ReturnType<typeof setInterval> | undefined;
  let started = false;
  let stopping = false;
  let sealedActivity: OrganizationRuntimeActivityV2 | undefined;
  /** In-process only: a restarted host admits, so a drained release ends drained-free. */
  let drainedSince: string | undefined;
  /** Synchronous v1 turns bypass the dispatcher; a drain is not drained while one is admitted or running. */
  let v1Turns = 0;

  /**
   * One projection, read the same way live and at shutdown. `active` is decided by
   * the dispatcher's own execution authority rather than the record's flag alone,
   * so a stopped host — whose dispatcher has already awaited every in-flight turn
   * — reports exactly the executions that were still admitted when it stopped.
   */
  const projectActivity = async (current: WakeAcceptanceStore, state: "running" | "stopped"): Promise<OrganizationRuntimeActivityV2> => {
    const executions = dispatcher?.activeExecutions() ?? [];
    const items = (await current.activity()).map((item) => ({ ...item, active: item.active && executions.some((execution) => execution.agent_id === item.agent_id && execution.delivery_ids.includes(item.delivery_id)) }));
    return { version: ACTIVITY_V2_VERSION, state, items, executions };
  };

  const hardReason = (): BlockReason | undefined => {
    if (!started || stopping) return stopping ? "host_stopping" : "host_stopped";
    if (dispatcher?.fatalReason()) return dispatcher.fatalReason();
    const reason = fuse?.tripped();
    return reason === "operator_stop" || reason === "ledger_unavailable" ? reason : undefined;
  };
  const accept = async (value: unknown): Promise<OrganizationRuntimeWakeAcceptanceResult> => {
    let request;
    try { request = parseWakeAcceptanceRequest(value); } catch { return rejected("invalid_request"); }
    if (!tokensEqual(expectedToken, request.token)) return rejected("unauthorized");
    if (!knownAgents.has(request.agent_id)) return rejected("unknown_agent");
    // Check the operator latch before taking ownership, even between polls.
    await fuse?.pollOperatorStop();
    const reason = hardReason(); if (reason) return blocked(reason);
    // A drain is an operator stop that can be undone; bridges already defer on this reason.
    if (drainedSince !== undefined) return blocked("operator_stop");
    const operation = (async (): Promise<OrganizationRuntimeWakeAcceptanceResult> => {
      try {
        const accepted = await store!.accept(request);
        // A stop racing this fsync cannot revoke already durable ownership.
        // It remains accepted for restart instead of being terminalized.
        dispatcher?.notify(request.agent_id, accepted.created);
        return publicAcceptance(accepted.record);
      } catch (error) {
        if (error instanceof WakeAcceptanceConflictError) return rejected("delivery_conflict");
        if (error instanceof WakeInboxFullError) return blocked("queue_full");
        throw error;
      }
    })();
    persistence.add(operation);
    try { return await operation; } finally { persistence.delete(operation); }
  };

  const availability = async (token: string | undefined): Promise<WorkAvailability | undefined> => {
    if (!tokensEqual(expectedToken, token) || !store || !fuse) return undefined;
    await fuse.pollOperatorStop();
    const items = await store.activityWithExecutionErrors();
    const executionErrors = new Map(items.filter((record) => (record.state === "accepted" || record.state === "running")
      && record.execution_error !== undefined).map((record) => [record.agent_id, record.execution_error!]));
    const agents = await Promise.all(config.agents.map(async (agent) => ({
      agent_id: agent.id, pending: items.filter((item) => item.agent_id === agent.id && (item.state === "accepted" || item.state === "running" && !dispatcher?.activeExecutions().some((execution) => execution.agent_id === agent.id))).length,
      running: dispatcher?.activeExecutions().some((execution) => execution.agent_id === agent.id) ?? false,
      deferred: items.filter((item) => item.agent_id === agent.id && item.state === "accepted" && item.deferred).length,
      budget: await fuse!.snapshot(agent.id, agent.attention),
      ...((dispatcher?.failure(agent.id) ?? executionErrors.get(agent.id))
        ? { error: dispatcher?.failure(agent.id) ?? executionErrors.get(agent.id) } : {})
    })));
    // "drained" only once no inbox loop is alive: nothing runs and nothing can start until resume.
    const drain: WorkDrain | undefined = drainedSince === undefined ? undefined : { state: dispatcher?.quiescent() === false || v1Turns > 0 ? "draining" : "drained", since: drainedSince };
    return { version: "noopolis.daimon.work-availability.v1", state: hardReason() ? "stopped" : drain !== undefined || agents.some((agent) => agent.budget.state !== "available" || agent.error) ? "paused" : "running", agents, ...(drain === undefined ? {} : { drain }) };
  };

  return {
    wake: async (request) => {
      try { request = parseOrganizationRuntimeWakeRequest(request); } catch { return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "", wakeId: "", code: "invalid_request" }; }
      // Attention and recording require durable ownership and dispatcher admission.
      if (!tokensEqual(expectedToken, request.token)) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "unauthorized" };
      if (!knownAgents.has(request.agentId)) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "unknown_agent" };
      const agent = config.agents.find((candidate) => candidate.id === request.agentId)!;
      if (agent.attention !== undefined || agent.recording !== undefined) return { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: request.agentId, wakeId: request.event.id, code: "durable_inbox_required" };
      // v1 has no `blocked` member on its wire; a drain answers it exactly as the latched stop does.
      if (hardReason() || drainedSince !== undefined) return { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: request.agentId, wakeId: request.event.id, code: "host_stopping" };
      v1Turns += 1;
      try {
        if ((await fuse!.admit(request.agentId, request.event.id, config.agents.find((agent) => agent.id === request.agentId)?.attention)).state !== "admitted") return { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: request.agentId, wakeId: request.event.id, code: "host_stopping" };
        return await host.wake(request);
      } finally { v1Turns -= 1; }
    },
    health: async (agentId) => await host.health(agentId),
    activity: async (request) => await host.activity(request),
    async start(): Promise<void> {
      if (started) return;
      const clock = readTaskClock();
      if (stopping) throw new Error("organization runtime control host has been stopped");
      if (!expectedToken?.trim()) throw new Error("required control token is missing or blank");
      const opened = await WakeAcceptanceStore.open(options.acceptanceStorePath, options.storeOptions);
      let openedFuse: WakeFuse | undefined;
      try {
        openedFuse = await WakeFuse.open({ organizationKey: [...knownAgents].sort().join("\u0000"), environment: options.fuseEnvironment });
        await host.start();
        store = opened; fuse = openedFuse; started = true;
        dispatcher = new AttentionDispatcher({ store, host, fuse, agents: config.agents, registry, token: expectedToken, onIdle: (agentId) => { void schedules?.drain(agentId).catch(() => undefined); } });
        if (!hardReason()) for (const agentId of new Set((await opened.recoverable(knownAgents)).filter((record) => !record.deferred).map((record) => record.agent_id))) dispatcher.notify(agentId);
        fusePoll = setInterval(() => {
          void fuse?.pollOperatorStop().then((reason) => {
            if (reason === "operator_stop" || reason === "ledger_unavailable") dispatcher?.halt();
          }).catch(() => undefined);
        }, options.fusePollIntervalMsForTest ?? WAKE_FUSE_OPERATOR_POLL_MS);
        fusePoll.unref();
        if (config.version === "noopolis.daimon.organization-runtime.v2") {
          schedules = createScheduleController({ acceptanceStorePath: options.acceptanceStorePath, agents: config.agents, ...options.scheduleOptions,
            // Calendar selection/state use task instants; due - taskNow remains a real delay.
            now: () => { const realNow = (options.scheduleOptions?.now ?? Date.now)(); return clock?.at(realNow) ?? realNow; },
            accept: async (occurrence) => {
              if (dispatcher?.busy(occurrence.agentId) || hardReason() || drainedSince !== undefined) return false;
              const result = await accept({ token: expectedToken, agent_id: occurrence.agentId, delivery_id: occurrence.deliveryId, event: { version: "noopolis.daimon.wake.v2", kind: "schedule", text: occurrence.prompt, occurred_at: occurrence.occurredAt } });
              return result.state === "accepted";
            }
          });
          await schedules.start();
        }
      } catch (error) {
        dispatcher?.halt(); await host.stop().catch(() => undefined); await dispatcher?.stop().catch(() => undefined);
        await openedFuse?.close().catch(() => undefined); await opened.close().catch(() => undefined);
        throw error;
      }
    },
    accept,
    async wakeReceipt(token, acceptanceId) {
      if (!tokensEqual(expectedToken, token) || store === undefined) return undefined;
      return await store.status(acceptanceId);
    },
    async activityV2(token) {
      if (!tokensEqual(expectedToken, token)) return undefined;
      // A stopped host is not an unanswerable one. Its sealed projection is a
      // *stronger* statement about quiescence than a live poll, because nothing
      // can be admitted after it, and a caller proving that an execution closed
      // has no other authority to read. A host that never started, or one whose
      // seal could not be taken, still answers nothing: absence stays absence
      // rather than becoming a fabricated idle runtime.
      if (store === undefined) return sealedActivity;
      return await projectActivity(store, "running");
    },
    availability,
    async drain(token) {
      if (!tokensEqual(expectedToken, token) || !store || !fuse) return undefined;
      drainedSince ??= new Date().toISOString();
      dispatcher?.pause();
      return await availability(token);
    },
    async resume(token) {
      if (!tokensEqual(expectedToken, token) || !store || !fuse) return undefined;
      if (drainedSince !== undefined) {
        drainedSince = undefined;
        // A latched operator stop or fatal fault outlives the drain: resume never reopens it.
        if (!hardReason()) {
          // An owed pass for every agent the drain withheld or that holds queued work;
          // owed passes never count as new input, so deferred deliveries stay deferred.
          const queued = new Set((await store.recoverable(knownAgents).catch(() => [])).filter((record) => !record.deferred).map((record) => record.agent_id));
          if (drainedSince === undefined && !hardReason()) dispatcher?.resume(queued);
          void schedules?.drain().catch(() => undefined);
        }
      }
      return await availability(token);
    },
    async stop(): Promise<OrganizationRuntimeShutdownCompletion> {
      if (!started && stopping) return { version: "noopolis.daimon.organization-runtime-stop.v1", state: "stopped" };
      stopping = true; dispatcher?.halt();
      if (fusePoll !== undefined) clearInterval(fusePoll);
      await schedules?.stop();
      await Promise.allSettled(persistence);
      const result = await host.stop();
      await dispatcher?.stop();
      // The last moment the store can be read, and the only one at which the
      // dispatcher has finished every admitted turn. Seal the projection here so
      // the closure query keeps an accurate answer once the store is closed; a
      // fault leaves it absent instead of inventing one.
      if (store) { try { sealedActivity = await projectActivity(store, "stopped"); } catch { /* an unreadable final state stays absent */ } }
      await store?.close(); await fuse?.close();
      store = undefined; fuse = undefined; schedules = undefined; started = false;
      return result;
    }
  };
}
export const WAKE_FUSE_OPERATOR_POLL_MS = 1000;
function rejected(code: "invalid_request" | "unauthorized" | "unknown_agent" | "delivery_conflict"): OrganizationRuntimeWakeAcceptanceResult { return { version: "noopolis.daimon.wake-acceptance.v2", state: "rejected", code }; }
function blocked(reason: BlockReason): OrganizationRuntimeWakeAcceptanceResult { return { version: "noopolis.daimon.wake-acceptance.v2", state: "stopped", code: reason === "host_stopped" ? "host_stopped" : "host_stopping", blocked: { version: "noopolis.daimon.work-blocked.v1", reason, retry_after_ms: 30000 } }; }
function tokensEqual(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected?.trim()) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(expected), digest(actual ?? ""));
}
