import { brokerTaskClockFileFor } from "./grokBrokerSlot.js";
import type { GrokWorkerConfigVariant } from "./grokBrokerTaskClockContract.js";
import {
  brokerClockObservation, parseBrokerProcessClock, prepareBrokerTaskClock,
  writeBrokerTaskClock, type BrokerShellClock, type BrokerClockObservation
} from "./grokBrokerTaskClock.js";
import { GrokBrokerProviderClock, type GrokBrokerProviderClockObservation } from "./grokBrokerProviderClock.js";
import { createHash, randomUUID } from "node:crypto";

import { engineBrokerCapabilityTtlMs } from "./engineBrokerCapabilities.js";
import { decodeGrokHeadlessTurn } from "../grokHeadlessResult.js";
import { decodeGrokStreamUsage, type GrokStreamUsage } from "../grokStreamUsage.js";
import {
  ENGINE_BROKER_VERSION, ENGINE_BROKER_TASK_CLOCK_RESET_FAILED,
  type EngineBrokerCleanupObservation, type EngineBrokerFailureCode, type EngineBrokerTerminalResponse
} from "./engineBrokerProtocol.js";
import type { EngineBrokerMcpCallObservation } from "./engineBrokerMcpCallLog.js";
import { lowerEngineBrokerTurnLimits, mapGrokReportedModel, type EngineBrokerTurnAccounting, type EngineBrokerTurnLimitOverrides, type EngineBrokerTurnUsage } from "./engineBrokerTurnAccounting.js";
import { NativeBrokerTurnFailure, type NativeBrokerDiagnostic, type NativeBrokerTurn, type NativeBrokerTurnResult } from "./engineBrokerNativeClient.js";
import type { EngineBrokerTurnRegistry } from "./engineBrokerTurnRegistry.js";
import { engineBrokerRequestLedgerPathFor, engineBrokerSealLedgerPathFor, type EngineBrokerServiceRegistration } from "./engineBrokerServiceConfig.js";
import { ensureBrokerTurnLedgered } from "./grokEngineBrokerLedger.js";
import { finishBrokerTurnWithUsage, type BrokerTurnMetering, type BrokerTurnMeteringDetail } from "./grokEngineBrokerMetering.js";
import type { GrokBrokerProxyTurn } from "./grokBrokerProxy.js";
import { GrokBrokerTurnMeter, type GrokBrokerTurnMeterSnapshot } from "./grokBrokerTurnMeter.js";
import { awaitGrokWorkerIdentityEmpty, findGrokWorkerProcess, GROK_WORKER_REAP_WAIT_MS, grokWorkerIdentityEmpty, watchGrokBrokerTurnEnd, type GrokBrokerTurnEndReason, type GrokBrokerTurnEndTiming, type GrokWorkerProcess } from "./grokEngineBrokerTurnEnd.js";
import type { EngineBrokerMcpActivity } from "./engineBrokerMcpCallLog.js";
import { GrokWorkerAttestationFailure } from "./grokWorkerAttestation.js";
import { grokWorkerToolProcessLive, grokWorkerToolProcessSampler } from "./grokWorkerToolProcess.js";

export type GrokEngineBrokerTurnResult = Readonly<{
  text: string; workerPid: number; workerUid: number; workerStartTime: string;
}> & EngineBrokerTurnAccounting & BrokerClockObservation & EngineBrokerCleanupObservation;
export class EngineBrokerTurnFailure extends Error {
  constructor(
    readonly code: Exclude<EngineBrokerFailureCode, "turn_conflict">,
    readonly diagnostic?: NativeBrokerDiagnostic,
    readonly accounting?: EngineBrokerTurnAccounting,
    readonly mcpCalls?: EngineBrokerMcpCallObservation,
    readonly shellClock?: BrokerShellClock,
    readonly providerClock?: GrokBrokerProviderClockObservation,
    readonly cleanupDiagnostic?: EngineBrokerCleanupObservation["cleanupDiagnostic"]
  ) { super("engine broker turn failed"); }
}

/** Everything one broker turn touches, injected so the accounting and limit paths run under test without a native launcher. */
export type GrokEngineBrokerTurnDependencies = Readonly<{
  turns: EngineBrokerTurnRegistry;
  proxy: Readonly<{ capabilities: Readonly<{ issue(agentId: string, turnId: string, ttlMs?: number): string; revoke(turnId: string): void }>; registerIsolationGuard(turnId: string, guard: () => Promise<void>): void; revokeIsolationGuard(turnId: string): void; registerTurn(turnId: string, turn: GrokBrokerProxyTurn): void; revokeTurn(turnId: string): void }>;
  mcp: Readonly<{ register(agentId: string, turnId: string, endpoint: string, ttlMs?: number): string; revoke(turnId: string): void; observe?(turnId: string): EngineBrokerMcpCallObservation | undefined; activity?(turnId: string): EngineBrokerMcpActivity | undefined }>;
  credentialStale(): boolean;
  prepareIsolation(registration: EngineBrokerServiceRegistration): Promise<Readonly<{ guard: () => Promise<void>; configVariant: GrokWorkerConfigVariant }>>;
  writeTaskClock?: typeof writeBrokerTaskClock;
  /** Startup attestation also owns cleanup when per-turn attestation fails. */
  clockedSlot?: boolean;
  /** A failed cleanup fences production dispatch until the broker restarts. */
  taskClockFailed?(): void;
  runNative(input: NativeBrokerTurn, signal: AbortSignal): Promise<Readonly<NativeBrokerTurnResult>>;
  /** The worker the launcher started for this identity (`/proc` by default); only read when the broker ends a turn itself. */
  observeWorker?(workerUid: number): Promise<GrokWorkerProcess | undefined>;
  /** Whether the worker identity has a live local tool process (default: `grokWorkerToolProcessLive` over `/proc`). */
  observeToolProcess?(workerUid: number): Promise<boolean>;
  /** Overrides the turn-end grace and idle bounds (tests). */
  turnEnd?: GrokBrokerTurnEndTiming;
  /** Whether no live process holds the worker identity (`/proc` by default); polled, bounded, before an aborted turn is sealed. */
  workerIdentityEmpty?(workerUid: number): Promise<boolean>;
  workerReapWaitMs?: number;
}>;

const limitReasonFor = { tokens: "token_ceiling", requests: "request_ceiling", timeout: "wake_timeout" } as const;
const usageOf = (usage: Readonly<{ input: number; cacheRead: number; cacheWrite: number; output: number; total: number }>): EngineBrokerTurnUsage => ({ input: usage.input, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, output: usage.output, total: usage.total });

/**
 * One brokered Grok turn under its declared limits.
 *
 * The limits are the registration's, lowered (never raised) by the wake. The
 * proxy meter refuses model requests past `maxRequests`, past the elapsed
 * deadline, or once the upstream-reported running total reached `maxTokens`,
 * and a tripped limit aborts the worker through the same cancel/kill path a
 * client cancellation uses. A wall-clock timer trips `timeout` for a worker
 * that is mid-request.
 *
 * Every terminal path — completed, failed, limit, cancelled — is sealed and
 * metered through {@link finishBrokerTurnWithUsage}; a replayed turn returns its
 * sealed accounting before any of this runs and never meters again.
 */
export async function runGrokEngineBrokerTurn(deps: GrokEngineBrokerTurnDependencies, registration: EngineBrokerServiceRegistration, wakeId: string, prompt: string, mcpEndpoint: string, signal?: AbortSignal, overrides?: EngineBrokerTurnLimitOverrides, processClock?: string): Promise<GrokEngineBrokerTurnResult> {
  const { agentId } = registration, declared = registration.model.model;
  const writeClock = deps.writeTaskClock ?? ((value: string | undefined) => writeBrokerTaskClock(value, brokerTaskClockFileFor(registration.slot)));
  let limits;
  try { limits = lowerEngineBrokerTurnLimits(registration.limits, overrides); if (processClock !== undefined) parseBrokerProcessClock(processClock); } catch { throw new EngineBrokerTurnFailure("invalid_request", undefined, { outcome: "failed", usage: null, model: declared, requests: 0, limitReason: "none" }); }
  const turnId = createHash("sha256").update(`${registration.slot}\0${agentId}\0${wakeId}`).digest("hex");
  const request = { version: ENGINE_BROKER_VERSION, kind: "start_turn", requestId: randomUUID(), turnId, slot: registration.slot, agentId, wakeId, prompt, mcpEndpoint, ...(overrides === undefined ? {} : { limits: overrides }), ...(processClock === undefined ? {} : { processClock }) } as const;
  const begun = await deps.turns.begin(request, declared);
  const metering: BrokerTurnMetering = { usageLedgerPath: registration.usageLedgerPath, requestLedgerPath: engineBrokerRequestLedgerPathFor(registration.usageLedgerPath), sealLedgerPath: engineBrokerSealLedgerPathFor(registration.usageLedgerPath), agentId, wakeId };
  if (begun !== "start") { await ensureBrokerTurnLedgered(begun.ledger, turnId, metering); return replay(begun.replay); }
  const clock = processClock === undefined ? undefined : new GrokBrokerProviderClock(processClock);
  const controller = new AbortController();
  let worker: Promise<GrokWorkerProcess | undefined> | undefined;
  const meter = new GrokBrokerTurnMeter(limits, () => controller.abort());
  let cancelledByCaller = false;
  const onAbort = () => { cancelledByCaller = true; controller.abort(); }; signal?.addEventListener("abort", onAbort, { once: true }); if (signal?.aborted) { cancelledByCaller = true; controller.abort(); }
  const timer = setTimeout(() => meter.trip("timeout"), limits.timeoutMs); timer.unref?.();
  // What was in flight, and which worker held the final reply, at the instant the
  // turn ended — read before killing the worker can close its calls or empty its
  // identity. A final reply the 1 s watchdog poll never saw is caught here too.
  let inFlightAtEnd = false;
  controller.signal.addEventListener("abort", () => {
    let mcp = 0;
    try { mcp = deps.mcp.activity?.(turnId)?.inFlight ?? 0; } catch { mcp = 0; }
    inFlightAtEnd = mcp > 0 || meter.busy();
    if (meter.finalReply() !== undefined) worker ??= (deps.observeWorker ?? findGrokWorkerProcess)(registration.workerUid).catch(() => undefined);
  }, { once: true });

  let shellClock: BrokerShellClock | undefined;
  let resetClock = deps.clockedSlot === true;
  let nativeStarted = false;
  let workerReaped = false;
  let sealedFailure: EngineBrokerTurnFailure | undefined;
  let nativeDiagnostic: NativeBrokerDiagnostic | undefined, attested = false, output: string | undefined, rejected = false, sealed: GrokEngineBrokerTurnResult | undefined;
  // Set when the broker itself ended the turn (`grokEngineBrokerTurnEnd.ts`); the worker seen at the final reply names the turn it ended.
  let endedBy: GrokBrokerTurnEndReason | undefined;
  let watchdog: Readonly<{ stop(): void }> | undefined, isolationGuard: (() => Promise<void>) | undefined;
  try {
    const isolation = await deps.prepareIsolation(registration);
    isolationGuard = isolation.guard;
    // Publication may throw after rename. Claim cleanup before attempting it.
    resetClock ||= isolation.configVariant === "clocked";
    const coverage = await prepareBrokerTaskClock(isolation.configVariant, processClock, writeClock);
    if (isolation.configVariant === "clocked" || processClock !== undefined) shellClock = coverage;
    deps.proxy.registerIsolationGuard(turnId, isolationGuard);
    deps.proxy.registerTurn(turnId, { policy: registration.model, meter, clock });
    const capabilityTtlMs = engineBrokerCapabilityTtlMs(limits.timeoutMs);
    const providerCapability = deps.proxy.capabilities.issue(agentId, turnId, capabilityTtlMs), mcpCapability = deps.mcp.register(agentId, turnId, mcpEndpoint, capabilityTtlMs);
    // A shell command Grok runs itself is work the proxy and facade never see.
    const toolProcess = grokWorkerToolProcessSampler(() => (deps.observeToolProcess ?? grokWorkerToolProcessLive)(registration.workerUid));
    watchdog = watchGrokBrokerTurnEnd({
      meter, activity: () => deps.mcp.activity?.(turnId), toolProcess: toolProcess.live, signal: controller.signal, ...(deps.turnEnd === undefined ? {} : { timing: deps.turnEnd }),
      // The worker is read once, as soon as it has made a request — long before
      // anything can end the turn and reap it — so a final reply is never left
      // without the worker that gave it.
      onPoll: () => { toolProcess.poll(); if (worker === undefined && meter.snapshot().requests > 0) worker = (deps.observeWorker ?? findGrokWorkerProcess)(registration.workerUid).catch(() => undefined); },
      onFinalReply: () => { worker ??= (deps.observeWorker ?? findGrokWorkerProcess)(registration.workerUid).catch(() => undefined); },
      // An idle stall is a deadline of its own: it trips the meter as a timeout, so it seals like one.
      onEnd: (reason) => { endedBy = reason; if (reason === "idle") meter.trip("timeout"); else controller.abort(); }
    });
    nativeStarted = true;
    const result = await deps.runNative({ slot: registration.slot, requestId: request.requestId, turnId, agentId, wakeId, prompt, providerCapability, mcpCapability }, controller.signal);
    nativeDiagnostic = result.diagnostic; output = result.text;
    if (result.workerUid !== registration.workerUid) throw new Error("engine broker worker identity mismatch");
    await isolationGuard(); attested = true;
    rejected = true;
    const decoded = decodeGrokHeadlessTurn(result.text), stream = decodeGrokStreamUsage(result.text);
    if (stream.reportedModels.some((reported) => mapGrokReportedModel(reported, declared) === undefined)) throw new Error("engine broker reported an undeclared model");
    rejected = false;
    const snapshot = meter.snapshot();
    if (snapshot.limitReason !== "none") throw new Error("engine broker turn limit reached");
    const usage = decoded.usage === undefined ? streamOrMeterUsage(stream, snapshot) : usageOf(decoded.usage);
    const accounting = { outcome: "completed", usage, model: declared, requests: requestCount(stream, snapshot), limitReason: "none" } as const;
    const observation = brokerClockObservation(shellClock, clock?.snapshot());
    const completed = {
      version: request.version, kind: "completed", requestId: request.requestId, turnId,
      text: decoded.text, workerPid: result.workerPid, workerUid: result.workerUid,
      workerStartTime: result.startTicks.toString(), ...observation, ...accounting
    } as const;
    const result_ = {
      text: completed.text, workerPid: completed.workerPid, workerUid: completed.workerUid,
      workerStartTime: completed.workerStartTime, ...observation, ...accounting
    };
    await finishBrokerTurnWithUsage(deps.turns, request, completed, metering, { notionalUsd: decoded.usage?.notionalUsd ?? 0, complete: decoded.usage?.complete ?? false, estimatedRequests: snapshot.estimatedRequests, requests: requestRows(stream, snapshot), ...(stream.sessionId === undefined ? {} : { session: stream.sessionId }) }, () => { sealed = result_; });
    return result_;
  } catch (error) {
    // Once the completed record is published it is the durable truth: anything
    // failing after that (metering) must neither re-seal the turn as failed nor
    // append a second row.
    if (sealed !== undefined) return sealed;
    watchdog?.stop();
    // A turn this broker aborted is sealed only once its worker identity is
    // empty (bounded): the agent's next turn must not start a worker the
    // previous launcher handler's identity-wide reap would kill.
    if (controller.signal.aborted) {
      workerReaped = await awaitGrokWorkerIdentityEmpty(
        registration.workerUid, deps.workerReapWaitMs ?? GROK_WORKER_REAP_WAIT_MS,
        deps.workerIdentityEmpty ?? ((uid) => grokWorkerIdentityEmpty(uid, undefined, resetClock))
      );
    }
    // Not aborted (an output-limit failure, say): nothing was killed, so the live view is the true one.
    if (!controller.signal.aborted) { let mcp = 0; try { mcp = deps.mcp.activity?.(turnId)?.inFlight ?? 0; } catch { mcp = 0; } inFlightAtEnd = mcp > 0 || meter.busy(); }
    const vetoed = cancelledByCaller || rejected || (output !== undefined && !attested) || inFlightAtEnd;
    // Finished work is completed work. A worker that gave its final reply and was
    // then ended by the broker, refused its stdout by the launcher's output bound,
    // or left idle into the deadline did its job; only its exit went wrong.
    const finished = vetoed ? undefined : await completedFromFinalReply(
      deps, registration, request, meter, error, endedBy, worker, isolationGuard,
      metering, (value) => { sealed = value; }, shellClock, clock
    ).catch(() => undefined);
    if (finished !== undefined) return finished;
    // Sealed completed but its ledger append failed: the published record is the truth, exactly as on the success path.
    if (sealed !== undefined) return sealed;
    const snapshot = meter.snapshot();
    // A turn the broker ended after an error response failed on that error, not on a cancellation.
    const failedResponse = meter.failedResponse();
    const code: EngineBrokerTurnFailure["code"] = snapshot.limitReason !== "none" ? "limit_exceeded" : deps.credentialStale() ? "auth_stale" : controller.signal.aborted && !(endedBy === "error_response" && !cancelledByCaller) ? "cancelled" : "engine_failed";
    const diagnostic = error instanceof NativeBrokerTurnFailure ? error.diagnostic : nativeDiagnostic && !attested ? { ...nativeDiagnostic, status: "worker_failed" as const, stage: "attestation" as const, failureClass: error instanceof GrokWorkerAttestationFailure ? error.failureClass : "profile_invalid" as const, profileApplied: false } : undefined;
    const stream = output === undefined ? undefined : decodeGrokStreamUsage(output);
    const accounting = { outcome: "failed", usage: streamOrMeterUsage(stream, snapshot), model: declared, requests: requestCount(stream, snapshot), limitReason: snapshot.limitReason } as const;
    // Read before the `finally` revokes this turn's MCP registration, and
    // swallowed like every other instrument here: it must never be the reason
    // a turn reports something other than why it failed.
    let mcpCalls: EngineBrokerMcpCallObservation | undefined;
    try { mcpCalls = deps.mcp.observe?.(turnId); } catch { mcpCalls = undefined; }
    const observation = brokerClockObservation(shellClock, clock?.snapshot());
    const failed: EngineBrokerTerminalResponse = {
      version: request.version, kind: "failed", requestId: request.requestId, turnId, code,
      ...observation, ...(diagnostic ? { diagnostic } : {}),
      ...(mcpCalls === undefined ? {} : { mcpCalls }), ...accounting
    };
    const reason = snapshot.limitReason !== "none" ? limitReasonFor[snapshot.limitReason] : rejected ? "turn_rejected" : code === "engine_failed" && failedResponse !== undefined ? failedResponse.kind : "unknown";
    const failure = new EngineBrokerTurnFailure(code, diagnostic, accounting, mcpCalls, shellClock, observation.providerClock);
    await finishBrokerTurnWithUsage(deps.turns, request, failed, metering, {
      notionalUsd: 0, complete: false, reason, estimatedRequests: snapshot.estimatedRequests,
      requests: requestRows(stream, snapshot), ...(stream?.sessionId === undefined ? {} : { session: stream.sessionId })
    }, () => { sealedFailure = failure; });
    throw failure;
  } finally {
    watchdog?.stop(); clearTimeout(timer); signal?.removeEventListener("abort", onAbort); meter.abortInFlight();
    try {
      deps.proxy.revokeTurn(turnId);
      deps.proxy.revokeIsolationGuard(turnId);
      deps.proxy.capabilities.revoke(turnId);
      deps.mcp.revoke(turnId);
    } finally {
      if (resetClock) {
        try {
          // A disconnected launcher client can settle before its worker is reaped.
          // Never change the clock of a surviving shell, or release the slot as healthy.
          if (nativeStarted && !workerReaped) {
            workerReaped = await awaitGrokWorkerIdentityEmpty(
              registration.workerUid, deps.workerReapWaitMs ?? GROK_WORKER_REAP_WAIT_MS,
              deps.workerIdentityEmpty ?? ((uid) => grokWorkerIdentityEmpty(uid, undefined, true))
            );
            if (!workerReaped) throw new Error("Grok broker task clock worker did not terminate");
          }
          await writeClock(undefined);
        } catch (error) {
          deps.taskClockFailed?.();
          // Cleanup cannot replace a published outcome. Report the live fence
          // on the wire without rewriting the seal or its accounting.
          if (sealed !== undefined) return { ...sealed, cleanupDiagnostic: ENGINE_BROKER_TASK_CLOCK_RESET_FAILED };
          if (sealedFailure !== undefined) throw new EngineBrokerTurnFailure(
            sealedFailure.code, sealedFailure.diagnostic, sealedFailure.accounting,
            sealedFailure.mcpCalls, sealedFailure.shellClock, sealedFailure.providerClock,
            ENGINE_BROKER_TASK_CLOCK_RESET_FAILED
          );
          throw new Error("Grok broker task clock cleanup failed; restart required", { cause: error });
        }
      }
    }
  }
}

function replay(response: EngineBrokerTerminalResponse): GrokEngineBrokerTurnResult {
  const accounting = { outcome: response.outcome, usage: response.usage, model: response.model, requests: response.requests, limitReason: response.limitReason };
  if (response.kind === "completed") return {
    text: response.text, workerPid: response.workerPid, workerUid: response.workerUid,
    workerStartTime: response.workerStartTime,
    ...brokerClockObservation(response.shellClock, response.providerClock), ...accounting, outcome: "completed"
  };
  const code = response.code === "turn_conflict" || response.code === "unavailable" ? "engine_failed" : response.code;
  throw new EngineBrokerTurnFailure(
    code, response.diagnostic as NativeBrokerDiagnostic | undefined, accounting,
    response.mcpCalls, response.shellClock, response.providerClock
  );
}

/**
 * The completed seal for a turn whose model gave its final reply but whose
 * worker never delivered stdout: the broker ended it (`final_reply`), the
 * launcher's output bound refused its stream (`output_limit`, which publishes
 * nothing), or it idled into the wall-clock deadline. The reply is the one the
 * proxy saw, already bounded with a marker (`boundGrokFinalReply`), the usage is
 * what the proxy metered, and the worker is the one the launcher reported or
 * the broker observed while it was alive. `undefined` — and the ordinary
 * failure seal — whenever any of that is missing, the isolation attestation
 * fails, or the failure was anything else (a token or request limit, a client
 * cancellation, an engine fault before the reply). The caller vetoes it outright
 * for a caller cancellation, a rejected or unattested stdout, and a model
 * request or MCP tool call still in flight.
 */
async function completedFromFinalReply(
  deps: GrokEngineBrokerTurnDependencies, registration: EngineBrokerServiceRegistration,
  request: Readonly<{
    version: typeof ENGINE_BROKER_VERSION; kind: "start_turn"; requestId: string;
    turnId: string; agentId: string; wakeId: string; prompt: string; mcpEndpoint: string;
  }>,
  meter: GrokBrokerTurnMeter, error: unknown, endedBy: GrokBrokerTurnEndReason | undefined,
  worker: Promise<GrokWorkerProcess | undefined> | undefined,
  isolationGuard: (() => Promise<void>) | undefined, metering: BrokerTurnMetering,
  onSealed: (result: GrokEngineBrokerTurnResult) => void,
  shellClock?: BrokerShellClock, clock?: GrokBrokerProviderClock
): Promise<GrokEngineBrokerTurnResult | undefined> {
  const final = meter.finalReply(), snapshot = meter.snapshot();
  if (final === undefined || isolationGuard === undefined || snapshot.usage === null) return undefined;
  // A token or request limit is never finished work, whatever else failed beside it.
  if (snapshot.limitReason === "tokens" || snapshot.limitReason === "requests") return undefined;
  const outputLimited = error instanceof NativeBrokerTurnFailure && error.diagnostic.failureClass === "output_limit" && error.diagnostic.workerPid > 0;
  if (!(endedBy === "final_reply" || outputLimited || (snapshot.limitReason === "timeout" && endedBy !== "idle"))) return undefined;
  const identity = outputLimited ? { pid: error.diagnostic.workerPid, uid: error.diagnostic.workerUid, startTicks: error.diagnostic.startTicks } : await (async () => { const seen = (await worker) ?? await (deps.observeWorker ?? findGrokWorkerProcess)(registration.workerUid).catch(() => undefined); return seen === undefined ? undefined : { ...seen, uid: registration.workerUid }; })();
  if (identity === undefined || identity.uid !== registration.workerUid) return undefined;
  await isolationGuard();
  const accounting = { outcome: "completed", usage: snapshot.usage, model: registration.model.model, requests: snapshot.requests, limitReason: "none" } as const;
  const observation = brokerClockObservation(shellClock, clock?.snapshot());
  const completed = {
    version: request.version, kind: "completed", requestId: request.requestId, turnId: request.turnId,
    text: final.text, workerPid: identity.pid, workerUid: identity.uid, workerStartTime: identity.startTicks,
    ...observation, ...accounting
  } as const;
  const result = {
    text: completed.text, workerPid: completed.workerPid, workerUid: completed.workerUid,
    workerStartTime: completed.workerStartTime, ...observation, ...accounting
  };
  await finishBrokerTurnWithUsage(deps.turns, request, completed, metering, { notionalUsd: 0, complete: meterMeasuredEveryRequest(snapshot), estimatedRequests: snapshot.estimatedRequests, requests: requestRows(undefined, snapshot) }, () => onSealed(result));
  return result;
}

/**
 * The proxy's account is the turn's whole account once every request it forwarded settled with
 * the provider's own usage: no request in flight, none charged an estimate. Grok 1.0.34 never
 * exits after its final reply, so this, not the worker's result frame, is how most turns end.
 */
const meterMeasuredEveryRequest = (snapshot: GrokBrokerTurnMeterSnapshot): boolean =>
  snapshot.requests > 0 && snapshot.estimatedRequests === 0 && snapshot.timings.every((timing) => timing.endedAt !== undefined && timing.usage !== undefined);

/** The proxy saw every forwarded request; the stream is the fallback when no request crossed this proxy. */
const requestCount = (stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): number => snapshot.requests > 0 ? snapshot.requests : stream?.requests.length ?? 0;

/** Best partial usage: the worker's own per-request frames when any arrived, else what upstream reported to the proxy. */
function streamOrMeterUsage(stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): EngineBrokerTurnUsage | null {
  if (stream !== undefined && stream.requests.length > 0) {
    const sum = (pick: (value: GrokStreamUsage["requests"][number]) => number) => stream.requests.reduce((total, value) => total + pick(value), 0);
    return { input: sum((value) => value.input), cacheRead: sum((value) => value.cacheRead), cacheWrite: sum((value) => value.cacheWrite), output: sum((value) => value.output), total: sum((value) => value.total) };
  }
  return snapshot.usage;
}

/** Per-request rows: stream usage with the proxy's own observation when both describe the same requests, else the proxy's measured requests. */
function requestRows(stream: GrokStreamUsage | undefined, snapshot: GrokBrokerTurnMeterSnapshot): BrokerTurnMeteringDetail["requests"] {
  if (stream !== undefined && stream.requests.length > 0) {
    const timed = snapshot.timings.length === stream.requests.length;
    return stream.requests.map((value, index) => ({ ...value, usageSource: "stream" as const, ...(timed ? observed(snapshot.timings[index]!) : {}) }));
  }
  return snapshot.timings.flatMap((timing, index) => timing.usage === undefined ? [] : [{ index, ...usageOf(timing.usage), usageSource: timing.estimated === true ? "estimated" as const : "upstream" as const, ...observed(timing) }]);
}
/**
 * What only the proxy saw of one request: its clock, and the tool-call names the
 * response carried. Both are attached on the stream path only when the two
 * descriptions are request-for-request aligned, because an unaligned index would
 * credit one request's attempt to another.
 */
const observed = (timing: GrokBrokerTurnMeterSnapshot["timings"][number]) => ({
  startedAt: timing.startedAt,
  ...(timing.endedAt === undefined ? {} : { endedAt: timing.endedAt }),
  ...(timing.toolCalls === undefined ? {} : { toolCalls: timing.toolCalls })
});
