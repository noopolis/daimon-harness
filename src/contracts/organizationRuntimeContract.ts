import { ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS, ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY } from "../engines/codex/configSchema.js";
import { ENGINE_IDS } from "../engines/descriptors.js";
import { GROK_CONFIG_CONDITION } from "../engines/grok/configSchema.js";
import { AGY_CONFIG_CONDITION } from "../engines/agy/configSchema.js";
import { WAKE_MOMENT_RECORDING_SCHEMA } from "./wakeMomentContract.js";

/** The data-only organization-runtime constants shared by product code and artifacts. */
export const ORGANIZATION_RUNTIME_VERSION = "noopolis.daimon.organization-runtime.v1" as const;
export const ORGANIZATION_RUNTIME_V2_VERSION = "noopolis.daimon.organization-runtime.v2" as const;
export const ORGANIZATION_RUNTIME_MAX_AGENTS = 32;
export const ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES = 1_048_576;
export const ORGANIZATION_RUNTIME_MAX_STRING_BYTES = 16_384;
export const ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS = 4_096;
/** Wider codepoint bound for agent `instructions` only; every other bounded string keeps the shared 4,096 cap. */
export const ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS = 16_384;
export const ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES = 16_384;
/**
 * Ceiling on `host.maxWakeTextBytes`, the organization's opt-in wider wake text
 * bound on the control API. The default stays the 16,384 bytes above; an
 * organization whose wakes carry whole documents (a training judge) declares more.
 */
export const ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES_CEILING = 262_144;
export const ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS = 31_536_000_000;
/**
 * Upper bound on `schedule.jitter_seconds`. Jitter exists to blur a wake's
 * wall-clock signature (see `RandomizedDelaySec` in systemd timers), not to
 * relocate it; one hour is generous next to the finest cron granularity (one
 * minute) while remaining small next to the daily/sub-daily cadences jitter
 * is meant for, so a jittered wake still lands recognizably "around" its
 * scheduled instant instead of drifting into the next slot's territory.
 */
export const ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS = 3_600;
export { ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS, ORGANIZATION_RUNTIME_CODEX_WORKSPACE_NO_NETWORK_POLICY };

const PRODUCTION_TOOL_PROPERTIES = {
  recording: WAKE_MOMENT_RECORDING_SCHEMA,
  attention: { type: "object", additionalProperties: false, properties: { maxBatchMessages: { type: "integer", minimum: 1, maximum: 32 }, maxBatchBytes: { type: "integer", minimum: 1024, maximum: 12000 }, maxExecutions: { type: "integer", minimum: 1, maximum: 9007199254740991 }, maxTokens: { type: "integer", minimum: 1, maximum: 9007199254740991 } } },
  mcp: { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false, required: ["name", "transport", "args", "env", "tools"], properties: {
    name: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS }, transport: { enum: ["stdio", "sse", "streamable_http"] },
    command: { type: "string", pattern: "^/" }, url: { type: "string" }, authSecretEnv: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
    args: { type: "array", maxItems: 32, items: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } }, env: { type: "object", additionalProperties: { type: "string" } },
    tools: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS } }
  } } },
  moltnet: { type: "object", additionalProperties: false, required: ["cliPath", "configPath", "networks"], properties: {
    cliPath: { type: "string", pattern: "^/" }, configPath: { type: "string", pattern: "^/" }, networks: { type: "array", maxItems: 16, items: { type: "object", additionalProperties: false, required: ["id", "rooms", "dms"], properties: { id: { type: "string", minLength: 1 }, rooms: { type: "array", uniqueItems: true, items: { type: "string", minLength: 1 } }, dms: { type: "boolean" } } } }
  } },
  memory: { type: "object", additionalProperties: false, required: ["runtimeHomePath"], properties: {
    runtimeHomePath: { type: "string", pattern: "^/", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS },
    source: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
    tokenBudget: { type: "integer", minimum: 1, maximum: 1000000 }
  } }
} as const;

/** Machine-readable companion schema for config producers and validators. */
export const ORGANIZATION_RUNTIME_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: ORGANIZATION_RUNTIME_VERSION, type: "object", additionalProperties: false,
  required: ["version", "host", "agents"],
  properties: {
    version: { const: ORGANIZATION_RUNTIME_VERSION },
    host: { type: "object", additionalProperties: false, required: ["bindHost", "port", "controlTokenEnv"], properties: {
      bindHost: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      port: { type: "integer", minimum: 1, maximum: 65_535 },
      controlTokenEnv: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      maxWakeTextBytes: { type: "integer", minimum: ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES, maximum: ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES_CEILING }
    } },
    agents: { type: "array", minItems: 1, maxItems: ORGANIZATION_RUNTIME_MAX_AGENTS, items: {
      type: "object", additionalProperties: false, required: ["id", "name", "instructions", "workspacePath", "runtimeHomePath", "engine"], properties: {
        id: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
        name: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
        instructions: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS, pattern: "\\S" },
        workspacePath: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^/" },
        runtimeHomePath: { type: "string", maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "^/" },
        engine: { type: "object", additionalProperties: false, required: ["kind"], properties: {
          kind: { enum: ENGINE_IDS },
          model: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
          reasoningEffort: { enum: ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS },
          codexSandbox: { type: "object", additionalProperties: false, required: ["mode", "networkAccess", "webSearch"], properties: {
            mode: { const: "workspace-write" }, networkAccess: { const: false }, webSearch: { const: "disabled" }
          } }
        }, allOf: [GROK_CONFIG_CONDITION, AGY_CONFIG_CONDITION] },
        ...PRODUCTION_TOOL_PROPERTIES
      }
    } }
  }
} as const;

export const ORGANIZATION_RUNTIME_SCHEDULE_SCHEMA = {
  oneOf: [
    { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { const: "disabled" } } },
    { type: "object", additionalProperties: false, required: ["kind", "interval_ms", "prompt"], properties: {
      kind: { const: "every" }, interval_ms: { type: "integer", minimum: 1, maximum: ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS },
      prompt: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      jitter_seconds: { type: "integer", minimum: 0, maximum: ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS }
    } },
    { type: "object", additionalProperties: false, required: ["kind", "cron", "timezone", "prompt"], properties: {
      kind: { const: "cron" }, cron: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      timezone: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      prompt: { type: "string", minLength: 1, maxLength: ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS, pattern: "\\S" },
      jitter_seconds: { type: "integer", minimum: 0, maximum: ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS }
    } }
  ]
} as const;

/** v2 adds exactly one normalized schedule to every agent; v1 stays unchanged. */
export const ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA = {
  ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  $id: ORGANIZATION_RUNTIME_V2_VERSION,
  properties: {
    ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties,
    version: { const: ORGANIZATION_RUNTIME_V2_VERSION },
    agents: {
      ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents,
      items: {
        ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items,
        required: [...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items.required, "schedule"],
        properties: {
          ...ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items.properties,
          schedule: ORGANIZATION_RUNTIME_SCHEDULE_SCHEMA
        }
      }
    }
  }
} as const;
