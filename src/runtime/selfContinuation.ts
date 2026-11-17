import { WAKE_V2_VERSION, type OrganizationRuntimeWakeAcceptanceRequest } from "./wakeAcceptanceTypes.js";

/**
 * A self-continuation is a turn an agent schedules for itself: one durable
 * `manual` delivery, accepted into its own inbox while the current turn runs and
 * dispatched after it ends. The next turn is a fresh engine session; it sees
 * the note and the workspace, never the turn that wrote them.
 *
 * The chain is bounded twice: one continuation per execution, and a chain of at
 * most {@link MAX_SELF_CONTINUATIONS} links, counted in the delivery id so the
 * bound survives a restart. The agent's attention budget bounds it as well.
 */
export const MAX_SELF_CONTINUATIONS = 3;
export const MAX_SELF_CONTINUATION_NOTE_CODEPOINTS = 2_000;
const PREFIX = "daimon-continue:";
const LINK = /^daimon-continue:(\d+):/u;

/** The chain link a delivery carries: 0 for any delivery that is not a continuation. */
export function continuationDepth(deliveryId: string): number {
  const match = LINK.exec(deliveryId);
  return match ? Number(match[1]) : 0;
}

export type SelfContinuation = Readonly<{ delivery_id: string; link: number; limit: number }>;

/** The acceptance request for the next link, or an error naming why it is refused. */
export function selfContinuationRequest(input: Readonly<{ token: string | undefined; agentId: string; executionId: string; deliveryIds: readonly string[]; note: string; now: Date }>):
  { request: OrganizationRuntimeWakeAcceptanceRequest; continuation: SelfContinuation } {
  const note = input.note.trim();
  if (!note) throw new Error("A continuation needs a note saying what the next turn should do");
  if ([...note].length > MAX_SELF_CONTINUATION_NOTE_CODEPOINTS) throw new Error(`A continuation note is at most ${MAX_SELF_CONTINUATION_NOTE_CODEPOINTS} characters; leave the detail in workspace files`);
  const link = Math.max(0, ...input.deliveryIds.map(continuationDepth)) + 1;
  if (link > MAX_SELF_CONTINUATIONS) throw new Error(`Continuation limit reached: this work already ran ${MAX_SELF_CONTINUATIONS} continued turns. Finish it in this turn or leave it for new input.`);
  const delivery_id = `${PREFIX}${link}:${input.executionId}`;
  const text = [
    `Continuation ${link} of at most ${MAX_SELF_CONTINUATIONS} that you scheduled for yourself in an earlier turn.`,
    "That turn's reasoning is not available here: work from this note and your workspace files.",
    "",
    note
  ].join("\n");
  return {
    request: { token: input.token, agent_id: input.agentId, delivery_id, event: { version: WAKE_V2_VERSION, kind: "manual", text, occurred_at: input.now.toISOString() } },
    continuation: { delivery_id, link, limit: MAX_SELF_CONTINUATIONS }
  };
}
