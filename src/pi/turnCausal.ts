import type { MemoryPrepareTurnResult } from "@noopolis/mneme";

import type { WakeEvent } from "../core/types.js";
import {
  emitTurnInputSubmitted,
  emitTurnOutputCompleted,
  resolveRunId,
  sha256Hex,
  type CausalEvent,
  type TurnInputSubmittedPayload,
  type TurnOutputCompletedPayload
} from "../observability/causalEvents.js";
import { summarizePrompt } from "./turnTrace.js";

/**
 * Principal grammar per `specs/CAUSAL.md` §3
 * (`^(agent|operator|system):.+`): the authenticated agent identity this
 * harness instance was started under, never a bare id and never model
 * output. See `stampTurnInputSubmitted`/`stampTurnOutputCompleted` below for
 * why `agentId` itself is trustworthy at this layer.
 */
export const agentPrincipalId = (agentId: string): string => `agent:${agentId}`;

export interface StampTurnInputSubmittedInput {
  agentId: string;
  event: WakeEvent;
  prepared?: MemoryPrepareTurnResult;
  promptText: string;
  runtimeHomePath: string;
  runId?: string;
}

/**
 * Stamps `turn.input.submitted` for one Pi turn, wiring piHarness's own
 * variables into `@noopolis/daimon`'s causal envelope (`../observability/
 * causalEvents.ts`).
 *
 * - `principal_id` is `agent:<agentId>` (`agentPrincipalId`, per the
 *   `specs/CAUSAL.md` §3 principal grammar). `src/pi/auth.ts` scopes LLM
 *   provider auth (Codex / Claude / API key) per harness instance rather
 *   than exposing a separate network identity token, so `agentId` — the
 *   identity this harness instance was started under (`AgentStartInput.id`,
 *   which also scopes its own `authPath`/`runtimeHomePath`) — is the
 *   truthful authenticated identity available at this layer.
 * - `cause_event_ids` chains to `event.id` (the WakeEvent id) plus any mneme
 *   recall ids from `prepared.recalledCausalEventIds`. `event.id` is no
 *   longer a same-process stand-in for the upstream moltnet
 *   `message.accepted` id: moltnet's bridge control POST now carries a real
 *   `event_id` (`protocol.MessageEventID`-shaped, `"moltnet:<messageID>"`)
 *   for every non-bootstrap wake, and the Pi control source
 *   (`src/runtime/pi/appControlSource.ts` `formatControlEventId`) threads
 *   that value verbatim into `WakeEvent.id` in preference to its own
 *   `context_id`+timestamp fallback. `WakeEvent` still does not carry a
 *   separately namespaced moltnet field — Daimon stays detached from
 *   Moltnet wiring (see repo `AGENTS.md`) — but `event.id` is now the same
 *   id moltnet itself stamped on `message.accepted`, so this chain is
 *   id-joined across authorities rather than merely locally consistent.
 *   `prepared.recalledCausalEventIds` (not `prepared.recall.selectedEventIds`)
 *   for the same reason: `recall.selectedEventIds` are mneme's raw
 *   kernel-log recall ids (`evt_<...>`), a different id namespace than the
 *   `mneme:<uuid>` ids mneme's own `memory.recalled` causal events are
 *   stamped under (`contract/causal.ts` `mnemeCausalEventId`). Chaining the
 *   raw recall id would never resolve against mneme's causal stream; the
 *   `recalledCausalEventIds` mneme exposes on `MemoryPrepareTurnResult` are
 *   the actual `event_id`s of the `memory.recalled` events it appended for
 *   this turn, so this cause link is id-joined the same way the moltnet
 *   link above is.
 * - `run_id` comes from trusted per-instance host context, with the historical
 *   environment fallback. Never from `event` or model output.
 */
export const stampTurnInputSubmitted = (
  input: StampTurnInputSubmittedInput
): Promise<CausalEvent<TurnInputSubmittedPayload>> =>
  emitTurnInputSubmitted({
    agentId: input.agentId,
    causeEventIds: [input.event.id, ...(input.prepared?.recalledCausalEventIds ?? [])],
    inputContentSha256: sha256Hex(input.event.text),
    inputMessageIds: [input.event.id],
    principalId: agentPrincipalId(input.agentId),
    promptSha256: summarizePrompt(input.promptText).sha256,
    runId: resolveRunId(undefined, input.runId),
    runtimeHomePath: input.runtimeHomePath,
    turnId: input.event.id
  });

export interface StampTurnOutputCompletedInput {
  agentId: string;
  causeEventId: string;
  outputText: string;
  runtimeHomePath: string;
  turnId: string;
  runId?: string;
}

/**
 * Stamps `turn.output.completed` once a Pi turn finishes successfully,
 * chained back via `cause_event_ids` to the `turn.input.submitted` id for
 * the same turn. `output_sha256` is over the harness-extracted reply text;
 * the model has no path to influence `cause_event_ids`, `run_id`, or
 * `principal_id` here.
 */
export const stampTurnOutputCompleted = (
  input: StampTurnOutputCompletedInput
): Promise<CausalEvent<TurnOutputCompletedPayload>> =>
  emitTurnOutputCompleted({
    agentId: input.agentId,
    causeEventIds: [input.causeEventId],
    outputSha256: sha256Hex(input.outputText),
    principalId: agentPrincipalId(input.agentId),
    runId: resolveRunId(undefined, input.runId),
    runtimeHomePath: input.runtimeHomePath,
    turnId: input.turnId
  });
