# Observability Guide

This folder contains reusable telemetry helpers for Daimon runtime examples and
future callers.

## Structure

- `orgObserver.ts` records per-turn behavior, consultation edges, recall
  provenance, correctness assertions, and benchmark rows.
- `causalEvents.ts` is Daimon's own copy of the `noopolis.causal-event.v1`
  envelope (see root `specs/causal-event.v1.schema.json` and
  `specs/CAUSAL.md`; this repo does not import that schema, it only
  conforms to it). Owns the `turn.input.submitted` / `turn.output.completed`
  payload shapes, the per-`(run_id, agent:<agentId>)` seq counter persisted
  at `runtimeHome/telemetry/causal.seq.json`, and the
  `runtimeHome/telemetry/causal.jsonl` appender. `piHarness.ts` is the only
  caller that stamps events through it.
- `controlCausal.ts` stamps `control.wake.accepted` / `control.wake.denied`
  (`specs/CAUSAL.md` enforcement point #3) for root's two wake-acceptance
  surfaces (`src/runtime/pi/appControlSource.ts`, root repo): the
  operator-only control endpoint and the Moltnet loopback delivery endpoint
  (`/agents/:slug/wake`). Exports `emitControlWakeAccepted` /
  `emitControlWakeDenied` for the operator endpoint, both of which stamp
  `principal_id` as `operator:<operatorName>` — the identity behind the
  caller's verified bearer token, never a value read from the request body —
  and `emitDeliveryWakeAccepted` for the delivery endpoint, which stamps the
  fixed `principal_id` `system:moltnet` (`DELIVERY_PRINCIPAL_ID`), never
  derived from a caller-supplied `from`/agent field. Authority-attribution
  rule: delivery-accepted wakes are always `system:moltnet`; operator-accepted
  wakes are always `operator:<name>` — never conflate the two paths.
  `emitDeliveryWakeAccepted` reuses the `control.wake.accepted` event type
  (same minimal payload shape: `target_agent_id`, `wake_kind`) plus
  `delivered_by: "moltnet"`, and its own `deliveryWakeAcceptedEventId`
  derivation so its event ids never collide with the operator path's. There
  is no delivery-side deny emitter — the delivery endpoint has no bearer-
  token deny path to stamp. Root is the only intended caller; this file has
  no knowledge of HTTP or tokens.
- `emitCausalFixture.ts` is a standalone fixture emitter (run via
  `npm run emit-causal-fixture`, or `npm run emit-causal-fixture:spoof` for
  the adversarial variant) that stamps a synthetic `turn.input.submitted` ->
  `turn.output.completed` chain into a scratch runtime home, for a future
  cross-repo conformance harness to invoke by path. Spoof mode embeds a
  forged identity claim in the fixture's input/output text but asserts the
  stamped `principal_id` never picks it up — see `runCausalFixture`'s
  in-function invariant check.
- `index.ts` exports the public observability helpers.
- `orgObserver.test.ts` / `causalEvents.test.ts` / `controlCausal.test.ts` /
  `emitCausalFixture.test.ts` cover behavior extraction and causal stamping
  without live engine calls.

## Rules

- Keep telemetry secret-safe by default. Store output excerpts and memory
  provenance, not raw credentials or hidden engine state.
- Observability must be engine-neutral. Do not import Pi, Grok, Agy, or Codex
  implementation details here. `emitCausalFixture.ts` stamps `agent:<id>`
  principals inline rather than importing `src/pi/turnCausal.ts`'s
  `agentPrincipalId` helper, for this reason.
- Keep generated runtime artifacts under the caller's ignored `.runtime/` tree.
- `causalEvents.ts` never reads `run_id` or `principal_id` from a WakeEvent,
  a model reply, or any other in-turn data — both are always caller-supplied
  (`turnCausal.ts` uses explicit trusted host context or `NOOPOLIS_RUN_ID` and stamps
  `principal_id` as `agent:<agentId>`, the authenticated agent identity; the
  root operator-control caller stamps `operator:<operatorName>` through
  `controlCausal.ts`). Keep it that way in any future caller. Principal
  values always follow the `specs/CAUSAL.md` §3 grammar
  (`^(agent|operator|system):.+`); never emit a bare id.
- Authority attribution is fixed by which endpoint accepted the wake, never
  by request content: root's Moltnet loopback delivery endpoint
  (`/agents/:slug/wake`) always stamps `system:moltnet` via
  `emitDeliveryWakeAccepted`; root's operator-only control endpoint always
  stamps `operator:control` (or the verified operator name) via
  `emitControlWakeAccepted`/`emitControlWakeDenied`. Neither emitter accepts
  or derives its principal from a caller-supplied `from`/agent field — keep
  it that way in any future caller.
