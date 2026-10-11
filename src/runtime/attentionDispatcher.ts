import { randomUUID } from "node:crypto";
import type { AttentionRegistry } from "./attention.js";
import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeHost, OrganizationRuntimeWakeResult } from "./organizationRuntime.js";
import { engineFailureDetail } from "./organizationRuntimeHost.js";
import { WakeAcceptanceStore, WakeExecutionClaimLostError, type WakeExecutionClaim } from "./wakeAcceptanceStore.js";
import { sanitizeExecutionError, type StoredWakeAcceptanceRecord } from "./wakeAcceptanceRecord.js";
import { STALE_QUEUED_DELIVERY_MS } from "./wakeAcceptanceRetention.js";
import { WakeFuse } from "./wakeFuse.js";
import { ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES } from "../contracts/organizationRuntimeContract.js";
import { grokDaimonToolName } from "../contracts/grokWorkerContract.js";
import { recordWakeMoment } from "./wakeMomentRecorder.js";

type Claimed = { record: StoredWakeAcceptanceRecord; claim: WakeExecutionClaim; done: boolean };
type Options = Readonly<{ store: WakeAcceptanceStore; host: OrganizationRuntimeHost; fuse: WakeFuse; agents: readonly OrganizationRuntimeAgentConfig[]; registry: AttentionRegistry; token: string | undefined; onIdle(agentId: string): void }>;

/** Durable deliveries wait here; only a selected execution reserves a budget slot. */
export class AttentionDispatcher {
  private readonly owner = randomUUID();
  private readonly work = new Map<string, Promise<void>>();
  private readonly observed = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private readonly active = new Map<string, { execution_id: string; delivery_ids: string[] }>();
  private readonly errors = new Map<string, string>();
  private stopping = false;
  /** Reversible drain: no new execution starts; durable deliveries stay queued. */
  private paused = false;
  /** Agents whose inbox loop gave up its turn to a drain; resume owes each one a pass. */
  private readonly pausedOut = new Set<string>();
  private fatal: "ledger_unavailable" | undefined;
  constructor(private readonly options: Options) {}

  notify(agentId: string, fresh = false): void {
    if (fresh) this.generations.set(agentId, (this.generations.get(agentId) ?? 0) + 1);
    if (this.stopping) return;
    // Every pass a drain withholds is owed back on resume.
    if (this.paused) { this.pausedOut.add(agentId); return; }
    if (this.work.has(agentId)) return;
    // An owed pass is not new input: it starts from the generation already seen, so
    // deferred deliveries stay deferred unless something really arrived meanwhile.
    const baseline = this.pausedOut.delete(agentId) ? this.observed.get(agentId) ?? 0 : 0;
    const task = this.drain(agentId, baseline).catch((error) => { this.observed.set(agentId, this.generations.get(agentId) ?? 0); this.errors.set(agentId, engineFailureDetail(error) ?? "inbox_storage_unavailable"); }).finally(() => {
      this.work.delete(agentId);
      // A resume that landed while this loop was still unwinding its paused exit found it busy; run the owed pass now.
      if (!this.stopping && ((this.generations.get(agentId) ?? 0) > (this.observed.get(agentId) ?? 0) || this.pausedOut.has(agentId))) this.notify(agentId);
      this.options.onIdle(agentId);
    });
    this.work.set(agentId, task);
  }

  fatalReason(): "ledger_unavailable" | undefined { return this.fatal; }
  busy(agentId: string): boolean { return this.work.has(agentId); }
  activeExecutions() { return [...this.active].map(([agent_id, value]) => ({ agent_id, ...value, state: "running" as const })); }
  failure(agentId: string): string | undefined { return this.errors.get(agentId); }
  async stop(): Promise<void> {
    this.stopping = true;
    for (const finish of this.waiters) finish();
    await Promise.allSettled(this.work.values());
    await this.options.store.releaseClaims(this.owner);
  }
  halt(): void { this.stopping = true; for (const finish of this.waiters) finish(); }
  /** Stops admitting executions; a running turn finishes and its records settle as usual. */
  pause(): void { this.paused = true; for (const finish of this.waiters) finish(); }
  /** Admits again and revisits every agent whose inbox moved while paused. */
  resume(queued: Iterable<string> = []): void {
    this.paused = false;
    // Agents with queued work get an owed pass too: a delivery parked before the
    // drain (a budget pause, say) has no generation of its own to wake it.
    for (const agentId of queued) this.pausedOut.add(agentId);
    for (const agent of this.options.agents) if ((this.generations.get(agent.id) ?? 0) > (this.observed.get(agent.id) ?? 0) || this.pausedOut.has(agent.id)) this.notify(agent.id);
  }
  /** True once no inbox loop is alive: nothing runs, and nothing can start until resume. */
  quiescent(): boolean { return this.work.size === 0; }

  private async drain(agentId: string, baseline = 0): Promise<void> {
    const agent = this.options.agents.find((value) => value.id === agentId)!;
    let observedGeneration = baseline;
    while (!this.stopping) {
      if (this.paused) { this.pausedOut.add(agentId); return; }
      const generation = this.generations.get(agentId) ?? 0;
      const stale: StoredWakeAcceptanceRecord[] = [];
      const records = (await this.options.store.recoverable(new Set(this.options.agents.map((value) => value.id)), (record) => { if (record.agent_id === agentId) stale.push(record); })).filter((record) => record.agent_id === agentId);
      for (const record of stale) await expireStaleDelivery(this.options.store, record);
      const selected = selectBatch(records, agent, generation > observedGeneration);
      observedGeneration = generation; this.observed.set(agentId, generation);
      this.errors.delete(agentId);
      if (!selected.length) return;
      const budget = await this.options.fuse.snapshot(agentId, agent.attention);
      if (budget.state !== "available") return;
      if (this.paused) { this.pausedOut.add(agentId); return; }
      const executionId = selected[0]!.execution_id ?? randomUUID();
      const acquired = await this.options.store.acquireClaim(selected[0]!.acceptance_id, this.owner, selected.map((record) => record.acceptance_id), executionId);
      if (acquired.state === "held") { await this.waitUntil(acquired.retry_at); continue; }
      if (acquired.state === "terminal") continue;
      const claimed: Claimed[] = selected.map((record) => ({ record, claim: acquired.claim, done: false }));
      for (const item of claimed) item.record = await this.options.store.transitionClaimed(item.record.acceptance_id, item.claim, "running", undefined, undefined, agent.attention === undefined ? undefined : { execution_id: executionId, deferred: false });
      // A member ended between selection and claim (another host's expiry or stop
      // reached it first): never wake cognition on a batch that includes it.
      if (claimed.some((item) => item.record.state !== "running")) {
        for (const item of claimed.filter((value) => value.record.state === "running")) await this.options.store.transitionClaimed(item.record.acceptance_id, item.claim, "accepted");
        await this.options.store.releaseClaim(claimed[0]!.claim); continue;
      }
      // A drain that arrived after the claim releases it before any budget is spent.
      // Admission is the drain's linearization point: a turn the fuse admitted before
      // the loop saw the drain is a running turn, and keeps the host "draining".
      const pausedBeforeAdmit = this.paused;
      const verdict = pausedBeforeAdmit ? undefined : await this.options.fuse.admit(agentId, randomUUID(), agent.attention);
      if (verdict?.state !== "admitted" || this.stopping) {
        if (pausedBeforeAdmit) this.pausedOut.add(agentId);
        for (const item of claimed) await this.options.store.transitionClaimed(item.record.acceptance_id, item.claim, "accepted");
        await this.options.store.releaseClaim(claimed[0]!.claim); return;
      }
      await this.execute(agent, claimed, executionId);
    }
  }

  private async execute(agent: OrganizationRuntimeAgentConfig, claimed: Claimed[], executionId: string): Promise<void> {
    const { store, registry, host, token, fuse } = this.options;
    // Serialize tool disposition and lease renewal against the same current claim.
    let mutation: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = mutation.then(operation); mutation = result.then(() => undefined, () => undefined);
      void result.catch((error) => { if (error instanceof WakeExecutionClaimLostError) this.failClosed(agent.id, error); });
      return result;
    };
    const heartbeat = setInterval(() => {
      void serialize(async () => {
        const renewed = await store.renewClaim(claimed[0]!.claim.acceptance_id, claimed[0]!.claim);
        for (const item of claimed) item.claim = renewed;
        for (const item of claimed.filter((value) => !value.done)) await store.transitionClaimed(item.record.acceptance_id, item.claim, "running");
      }).catch((error) => this.failClosed(agent.id, error));
    }, store.claimHeartbeatIntervalMs());
    this.active.set(agent.id, { execution_id: agent.attention === undefined ? claimed[0]!.record.delivery_id : executionId, delivery_ids: claimed.map((item) => item.record.delivery_id) });
    const messages = claimed.map(({ record }) => ({ acceptance_id: record.acceptance_id, delivery_id: record.delivery_id, ...record.event }));
    if (agent.attention !== undefined) registry.set(agent.id, {
      executionId, messages, budget: () => fuse.snapshot(agent.id, agent.attention),
      disposition: (deliveryId, disposition) => serialize(async () => {
        const item = claimed.find((value) => value.record.delivery_id === deliveryId);
        if (!item) throw new Error("Delivery is outside this agent's selected inbox turn");
        if (item.done && item.record.state === "completed") {
          if (disposition !== "complete") throw new Error("A completed delivery cannot be deferred");
          return;
        }
        if (item.done && disposition === "defer") return;
        item.record = await store.transitionClaimed(item.record.acceptance_id, item.claim, disposition === "complete" ? "completed" : "accepted", undefined, disposition === "complete" ? "" : undefined, disposition === "defer" ? { deferred: true, clear_execution: true, execution_error: null } : { execution_id: executionId, deferred: false, execution_error: null });
        item.done = true;
      })
    });
    let result: OrganizationRuntimeWakeResult;
    try {
      const first = claimed[0]!.record;
      if (agent.recording) {
        await recordWakeMoment(agent, agent.attention === undefined ? first.delivery_id : executionId, claimed.map(({ record }) => record));
      }
      result = await host.wake({ token, agentId: agent.id, event: {
        version: "noopolis.daimon.wake.v1", id: agent.attention === undefined ? first.delivery_id : executionId, kind: first.event.kind,
        occurredAt: first.event.occurred_at,
        text: agent.attention === undefined ? first.event.text : inboxPrompt(messages, agent.engine.kind, agent.attention.maxBatchBytes)
      } });
    } catch (error) {
      result = { version: "noopolis.daimon.wake-result.v1", status: "failed", agentId: agent.id, wakeId: executionId, code: "engine_failed", detail: engineFailureDetail(error) };
    } finally { clearInterval(heartbeat); }
    try {
      await mutation;
      const executionError = result.status === "rejected" ? `wake rejected: ${result.code}`
        : result.status === "failed" ? `engine_failed: ${result.detail ?? "engine execution failed"}` : null;
      for (const item of claimed.filter((value) => !value.done)) {
        // Returned to the inbox for restart, and recording WHY. Only a WAKE OUTCOME
        // decides this: `stopped` — which an aborted in-flight wake also carries, with
        // its own code — is the runtime reclaiming work nobody read. The dispatcher's
        // own halt is not an outcome and must not stand in for one; it guards the
        // pre-wake path, where it belongs. Keying on it here discarded a completed
        // wake's evidence because the host happened to be halting, leaving a record
        // byte-identical to "never ran". Production tolerated it because a restart
        // re-delivers; a one-shot isolated trial has no restart and simply lost it.
        if (result.status === "stopped") {
          await store.transitionClaimed(item.record.acceptance_id, item.claim, "accepted", result.code);
        }
        else if (agent.attention !== undefined) {
          // Successful reading is not completion: an undisposed delivery of a
          // completed execution waits, deferred, for new input.
          //
          // A failed execution is retried ONCE, at once, under a fresh execution
          // id. Keeping its id made every retry the same broker turn — a sealed
          // failure replays forever and a changed prompt is a turn conflict — and
          // deferring it left work a turn died on (a token ceiling after a
          // validated revision) waiting for mail that might never come. The
          // record's `execution_error` is the bound: it is set by the failure and
          // cleared only by a disposition or a completed execution, so a delivery
          // that fails again is deferred like any other.
          const retry = result.status === "failed" && item.record.execution_error === undefined;
          await store.transitionClaimed(item.record.acceptance_id, item.claim, "accepted", undefined, undefined, { deferred: !retry, clear_execution: result.status !== "rejected", execution_error: executionError });
          if (retry) console.error(`daimon: wake requeued once agent=${agent.id} delivery=${item.record.delivery_id} after ${sanitizeExecutionError(executionError ?? "engine_failed")}`);
        } else if (result.status === "completed") await store.transitionClaimed(item.record.acceptance_id, item.claim, "completed", undefined, result.text);
        else await store.transitionClaimed(item.record.acceptance_id, item.claim, "failed", "engine_failed", result.status === "failed" ? result.detail : undefined);
      }
    } finally { this.active.delete(agent.id); registry.delete(agent.id); await store.releaseClaim(claimed[0]!.claim); }
  }

  private failClosed(agentId: string, error: unknown): void {
    this.errors.set(agentId, engineFailureDetail(error) ?? "execution_claim_lost");
    this.fatal = "ledger_unavailable";
    this.options.registry.clear(); this.active.clear(); this.halt();
    // Losing a fence revokes runtime/tool authority before stopping cognition.
    // This host has no per-agent abort lifecycle, so fail closed.
    void this.options.host.stop().catch(() => undefined);
  }

  private async waitUntil(timestamp: string): Promise<void> {
    if (this.stopping || this.paused) return;
    await new Promise<void>((resolve) => {
      const finish = (): void => { clearTimeout(timer); this.waiters.delete(finish); resolve(); };
      const timer = setTimeout(finish, Math.max(1, Date.parse(timestamp) - Date.now())); this.waiters.add(finish);
    });
  }
}

/**
 * A delivery past `STALE_QUEUED_DELIVERY_MS` is stopped `queued_wake_stopped`
 * where the dispatcher meets it, and the stop is logged: an expiry nobody can
 * see reads, in every artifact, like work that was never sent. Stopping goes
 * through the store's accepted-only seam, so a delivery claimed in the meantime
 * is left alone; a failure to stop is logged and retried on the next drain.
 */
async function expireStaleDelivery(store: WakeAcceptanceStore, record: StoredWakeAcceptanceRecord): Promise<void> {
  try {
    const stopped = await store.transitionAcceptedToStopped(record.acceptance_id, "queued_wake_stopped");
    if (stopped.state === "stopped") console.error(`daimon: wake expired agent=${record.agent_id} delivery=${record.delivery_id} accepted_at=${record.accepted_at} unhandled past ${STALE_QUEUED_DELIVERY_MS / 3_600_000}h; stopped queued_wake_stopped${record.execution_error === undefined ? "" : ` (last failure: ${record.execution_error})`}`);
  } catch (error) {
    console.error(`daimon: wake expiry failed agent=${record.agent_id} delivery=${record.delivery_id}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export function selectBatch(records: readonly StoredWakeAcceptanceRecord[], agent: OrganizationRuntimeAgentConfig, revisitDeferred: boolean): StoredWakeAcceptanceRecord[] {
  const eligible = records.filter((record) => !record.deferred || revisitDeferred);
  const first = eligible[0];
  if (!first) return [];
  // A durable execution identity survives a crash and partially completed batch.
  if (first.execution_id !== undefined) return records.filter((record) => record.execution_id === first.execution_id);
  if (agent.attention === undefined || first.event.kind !== "message") return [first];
  const selected: StoredWakeAcceptanceRecord[] = [];
  const count = agent.attention.maxBatchMessages ?? 8;
  const bytes = agent.attention.maxBatchBytes ?? 12000;
  for (const record of eligible) {
    if (record.event.kind !== "message" || record.execution_id !== undefined || selected.length >= count) break;
    const next = [...selected, record];
    if (Buffer.byteLength(JSON.stringify(next.map((value) => ({ acceptance_id: value.acceptance_id, delivery_id: value.delivery_id, ...value.event })))) > bytes) break;
    selected.push(record);
  }
  // Oversized individual payloads remain intact in daimon_inbox, not a silently
  // truncated synthetic wake. The prompt references its durable delivery id.
  return selected.length ? selected : [first];
}

/** One claimed delivery, rendered as the task it is. */
function deliveryBlock(message: unknown, index: number): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const row = message as Record<string, unknown>;
  const text = typeof row.text === "string" ? row.text : undefined;
  if (text === undefined) return undefined;
  const from = typeof row.from === "string" ? row.from : undefined;
  const kind = typeof row.kind === "string" ? row.kind : "delivery";
  const id = typeof row.delivery_id === "string" ? row.delivery_id : `#${index + 1}`;
  return [`<delivery id="${id}" kind="${kind}"${from === undefined ? "" : ` from="${from}"`}>`, text, "</delivery>"].join("\n");
}

/**
 * The inbox turn, task first.
 *
 * A delivery's own text *is* the work. Leading with bookkeeping and handing the
 * model `JSON.stringify(messages)` buried the task: an agent read the JSON, did
 * the accounting and deferred without doing the job (observed on Grok: nine
 * model requests, no tool calls, nothing filed). The deliveries are therefore
 * rendered as labelled blocks and the `daimon_inbox` accounting follows them as
 * what to do *after* the work, with the machine-readable payload kept as a
 * trailing appendix while it fits the same budget.
 *
 * Both tools are named the way the agent's own engine can call them. On Grok a
 * Daimon tool is an MCP tool of server `daimon` and its bare name reaches
 * nothing (`grokDaimonToolName`, the same contract module the worker's system
 * prompt and identity envelope render from), so an agent handed the bare name
 * cannot mark its work complete — and an unmarked, finished wake is recorded as
 * deferred.
 */
export function inboxPrompt(messages: readonly unknown[], engine: OrganizationRuntimeAgentConfig["engine"]["kind"], maxBytes = 12000): string {
  const body = JSON.stringify(messages);
  const blocks = messages.map(deliveryBlock).filter((block): block is string => block !== undefined);
  const tool = (name: string): string => engine === "grok" ? grokDaimonToolName(name) : name;
  const accounting = `\nWhen the work above is done, record each delivery with ${tool("daimon_inbox_disposition")} (complete), or defer the ones you could not finish; use ${tool("daimon_inbox")} for deliveries and remaining allowances. Reading or ending this turn never completes a delivery, and deferred work waits for a later external wake.\n`;
  const header = blocks.length === 1 ? "Carry out this delivery.\n" : `Carry out these ${blocks.length} deliveries.\n`;
  const fits = (value: string): boolean => Buffer.byteLength(value) <= ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES
    && [...value].length <= ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS;
  if (blocks.length > 0 && Buffer.byteLength(blocks.join("\n\n")) <= maxBytes) {
    const task = header + blocks.join("\n\n") + accounting;
    const withPayload = `${task}\nMachine-readable payload: ${body}`;
    // The inbox budget bounds selection; the v1 execution boundary independently
    // bounds the complete prompt, including metadata, escaping, and instructions.
    if (Buffer.byteLength(body) <= maxBytes && fits(withPayload)) return withPayload;
    if (fits(task)) return task;
  }
  const prefix = `Handle this inbox turn. Use ${tool("daimon_inbox")} for deliveries and remaining allowances. Explicitly call ${tool("daimon_inbox_disposition")} for each handled delivery (complete) or unfinished delivery (defer). Reading or ending this turn never completes a delivery. Deferred work waits for a later external wake.\n`;
  const prompt = prefix + body;
  if (Buffer.byteLength(body) > maxBytes || !fits(prompt)) {
    return prefix + `The selected payload exceeds the prompt budget; read it with ${tool("daimon_inbox")}.`;
  }
  return prompt;
}
