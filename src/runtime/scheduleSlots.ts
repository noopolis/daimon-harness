import { createHash } from "node:crypto";
import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeSchedule } from "./organizationRuntime.js";

export type ActiveSchedule = Exclude<OrganizationRuntimeSchedule, { kind: "disabled" }>;
export type ScheduleSlot = Readonly<{ agentId: string; schedule: ActiveSchedule; key: string; dream?: true }>;

export const DREAM_DELIVERY_PREFIX = "schedule:dream:";

export function workScheduleKey(agentId: string, schedule: ActiveSchedule): string {
  return createHash("sha256").update(JSON.stringify({ agentId, schedule })).digest("hex");
}

export function dreamSlot(agent: OrganizationRuntimeAgentConfig): ScheduleSlot | undefined {
  const memory = agent.memory;
  const schedule = memory?.dreamSchedule;
  if (memory === undefined || schedule === undefined || schedule.kind === "disabled") return undefined;
  const { runtimeHomePath, source } = memory;
  const key = createHash("sha256").update(JSON.stringify({ kind: "dream", agentId: agent.id, schedule, runtimeHomePath, source })).digest("hex");
  return { agentId: agent.id, schedule, key, dream: true };
}

export function isCanonicalScheduleDeliveryId(value: string): boolean {
  if (value.length > 256) return false;
  const prefix = value.startsWith(DREAM_DELIVERY_PREFIX) ? DREAM_DELIVERY_PREFIX : "schedule:";
  if (!value.startsWith(prefix) || !/^[a-f0-9]{64}:/.test(value.slice(prefix.length))) return false;
  const occurrence = value.slice(prefix.length + 65);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(occurrence)
    || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}@(?:GMT(?:[+-]\d{2}:\d{2})?|UTC)$/u.test(occurrence);
}
