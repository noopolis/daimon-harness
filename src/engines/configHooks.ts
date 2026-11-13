import { ORGANIZATION_RUNTIME_MAX_TURN_TIMEOUT_MS, ORGANIZATION_RUNTIME_MIN_TURN_TIMEOUT_MS } from "../contracts/organizationRuntimeContract.js";
import type { OrganizationRuntimeEngineIntent } from "../runtime/organizationRuntime.js";

export type EngineConfigRecord = Record<string, unknown>;
export type EngineConfigParsers = Readonly<{
  object(value: unknown, label: string): EngineConfigRecord;
  string(value: unknown, label: string): string;
  nonEmpty(value: unknown, label: string): string;
  exact(value: EngineConfigRecord, expected: readonly string[], label: string): void;
}>;
/** An agent's optional `engine.turnTimeoutMs`, within the contract's bounds. */
export function parseTurnTimeoutMs(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < ORGANIZATION_RUNTIME_MIN_TURN_TIMEOUT_MS || (value as number) > ORGANIZATION_RUNTIME_MAX_TURN_TIMEOUT_MS) {
    throw new TypeError(`${label} must be an integer from ${ORGANIZATION_RUNTIME_MIN_TURN_TIMEOUT_MS} to ${ORGANIZATION_RUNTIME_MAX_TURN_TIMEOUT_MS}`);
  }
  return value as number;
}
export interface ConfigEngineHooks {
  parseConfig(input: EngineConfigRecord, label: string, parsers: EngineConfigParsers): OrganizationRuntimeEngineIntent;
}
