import { ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS, ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY } from "./configSchema.js";
import type { OrganizationRuntimeEngineIntent } from "../../runtime/organizationRuntime.js";
import { parseTurnTimeoutMs, type ConfigEngineHooks, type EngineConfigParsers } from "../configHooks.js";

export const codexConfigHooks: ConfigEngineHooks = {
  parseConfig(input, label, parsers) {
    const allowed = ["kind", "model", "reasoningEffort", "codexSandbox", "turnTimeoutMs"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new TypeError(`${label} must contain exactly ${allowed.join(", ")}`);
    return {
      kind: "codex",
      ...(input.model === undefined ? {} : { model: parsers.nonEmpty(input.model, `${label}.model`) }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort(input.reasoningEffort, `${label}.reasoningEffort`, parsers) }),
      ...(input.codexSandbox === undefined ? {} : { codexSandbox: codexSandbox(input.codexSandbox, `${label}.codexSandbox`, parsers) }),
      ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: parseTurnTimeoutMs(input.turnTimeoutMs, `${label}.turnTimeoutMs`) })
    };
  }
};

function codexSandbox(value: unknown, label: string, { object, exact }: EngineConfigParsers): OrganizationRuntimeEngineIntent["codexSandbox"] {
  const input = object(value, label);
  exact(input, ["mode", "networkAccess", "webSearch"], label);
  if (input.mode !== ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY.mode || input.networkAccess !== false || input.webSearch !== ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY.webSearch) {
    throw new TypeError(`${label} must be workspace-write with network disabled and web search disabled`);
  }
  return ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY;
}

function reasoningEffort(value: unknown, label: string, { string }: EngineConfigParsers): string {
  const result = string(value, label);
  if (!ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS.includes(result as (typeof ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS)[number])) {
    throw new TypeError(`${label} must be one of ${ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS.join(", ")}`);
  }
  return result;
}
