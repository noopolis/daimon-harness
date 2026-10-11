import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readTaskClock } from "./taskClock.js";

import type { AttentionConfig } from "../contracts/attentionContract.js";
export type { AttentionConfig } from "../contracts/attentionContract.js";
export type AttentionMessage = Readonly<{ delivery_id: string; acceptance_id: string; kind: string; text: string; occurred_at: string }>;
export type AttentionTurn = Readonly<{
  executionId: string;
  messages: readonly AttentionMessage[];
  budget(): Promise<unknown>;
  disposition(deliveryId: string, disposition: "complete" | "defer"): Promise<void>;
}>;
/** Owned by one control host; never shared across hosts or agent identities. */
export type AttentionRegistry = Map<string, AttentionTurn>;

/** Envelope time is Daimon's view of now; text may contain historical Moltnet data.
 * Native schedule occurrences already use the task calendar and must not shift twice.
 */
export function taskClockAttentionMessages<T extends { kind: string; occurred_at: string }>(messages: readonly T[]): readonly T[] {
  const clock = readTaskClock();
  if (clock === undefined) return messages;
  const now = new Date(clock.now()).toISOString();
  return messages.map((message) => message.kind === "schedule" ? message : { ...message, occurred_at: now });
}

export function attentionTools(agentId: string, registry: AttentionRegistry): ToolDefinition[] {
  const current = (): AttentionTurn => { const turn = registry.get(agentId); if (!turn) throw new Error("No active inbox turn"); return turn; };
  return [{
    name: "daimon_inbox", label: "Current inbox", description: "Read this turn's selected deliveries and remaining execution allowance. Reading does not complete a delivery. Explicitly complete or defer each selected message.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute() {
      const turn = current();
      const budget = await turn.budget();
      const clock = readTaskClock();
      const visibleBudget = clock !== undefined && budget !== null && typeof budget === "object" && "epoch" in budget && typeof budget.epoch === "string"
        ? { ...budget, epoch: budget.epoch.replace(/^(organization-[a-f0-9]{64}-)\d{4}-\d{2}-\d{2}$/u, `$1${new Date(clock.now()).toISOString().slice(0, 10)}`) } : budget;
      const details = { version: "noopolis.daimon.inbox.v1", execution_id: turn.executionId, messages: taskClockAttentionMessages(turn.messages), budget: visibleBudget };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    }
  }, {
    name: "daimon_inbox_disposition", label: "Resolve an inbox delivery", description: "Mark one selected delivery complete only after handling it, or defer it until a later external wake. Unmarked deliveries stay pending. Completion is durable and cannot be undone.",
    parameters: { type: "object", additionalProperties: false, required: ["delivery_id", "disposition"], properties: { delivery_id: { type: "string", minLength: 1 }, disposition: { enum: ["complete", "defer"] } } },
    async execute(_id, params) {
      const input = params as { delivery_id: string; disposition: "complete" | "defer" };
      if (input.disposition !== "complete" && input.disposition !== "defer") throw new Error("Invalid inbox disposition");
      await current().disposition(input.delivery_id, input.disposition);
      const details = { delivery_id: input.delivery_id, disposition: input.disposition };
      return { content: [{ type: "text", text: JSON.stringify(details) }], details };
    }
  }] as ToolDefinition[];
}

export function parseAttention(value: unknown): AttentionConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("attention must be an object");
  const result = value as Record<string, unknown>;
  const bounds = { maxBatchMessages: [1, 32], maxBatchBytes: [1024, 12000], maxExecutions: [1, Number.MAX_SAFE_INTEGER], maxTokens: [1, Number.MAX_SAFE_INTEGER] } as const;
  for (const [key, value] of Object.entries(result)) {
    const bound = bounds[key as keyof typeof bounds];
    if (!Object.hasOwn(bounds, key) || !bound || typeof value !== "number" || !Number.isSafeInteger(value) || value < bound[0] || value > bound[1]) throw new TypeError(`attention.${key} is outside its bound`);
  }
  return { ...result } as AttentionConfig;
}
