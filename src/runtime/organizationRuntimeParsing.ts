import { ENGINE_IDS } from "../engines/descriptors.js";
import { getEngineHandler } from "../engines/registry.js";
import { parseAttention } from "./attention.js";
import { isolateRecording, parseRecording } from "./organizationRuntimeRecording.js";
import {
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES,
  ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS,
  ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES,
  ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES_CEILING,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS,
  ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS,
  ORGANIZATION_RUNTIME_V2_VERSION,
  ORGANIZATION_RUNTIME_VERSION,
  type OrganizationRuntimeAgentConfig,
  type OrganizationRuntimeConfig,
  type OrganizationRuntimeEngineIntent,
  type OrganizationRuntimeEngineKind,
  type OrganizationRuntimeHostConfig,
  type OrganizationRuntimeSchedule,
  type OrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";

type RecordValue = Record<string, unknown>;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENGINE_KINDS = new Set<string>(ENGINE_IDS);
const CRON_FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export function parseOrganizationRuntimeConfig(value: unknown): OrganizationRuntimeConfig {
  const root = object(snapshot(value, "config"), "config");
  size(root);
  exact(root, ["version", "host", "agents"], "config");
  const version = string(root.version, "config.version");
  if (version !== ORGANIZATION_RUNTIME_VERSION && version !== ORGANIZATION_RUNTIME_V2_VERSION) throw new TypeError("config.version is not supported");
  const hostValue = object(root.host, "config.host");
  exactOptional(hostValue, ["bindHost", "port", "controlTokenEnv"], ["maxWakeTextBytes"], "config.host");
  const host: OrganizationRuntimeHostConfig = {
    bindHost: nonEmpty(hostValue.bindHost, "config.host.bindHost"), port: port(hostValue.port, "config.host.port"), controlTokenEnv: envName(hostValue.controlTokenEnv, "config.host.controlTokenEnv"),
    ...(hostValue.maxWakeTextBytes === undefined ? {} : { maxWakeTextBytes: wakeTextBound(hostValue.maxWakeTextBytes) })
  };
  const rawAgents = array(root.agents, "config.agents");
  if (rawAgents.length === 0 || rawAgents.length > ORGANIZATION_RUNTIME_MAX_AGENTS) throw new TypeError(`config.agents must contain between 1 and ${ORGANIZATION_RUNTIME_MAX_AGENTS} agents`);
  const ids = new Set<string>();
  const agents = rawAgents.map((item, index) => {
    const agent = parseAgent(item, `config.agents[${index}]`, version === ORGANIZATION_RUNTIME_V2_VERSION);
    if (ids.has(agent.id)) throw new TypeError(`config.agents has duplicate id ${agent.id}`);
    ids.add(agent.id);
    return agent;
  });
  isolated(agents);
  isolatedMemory(agents);
  isolateRecording(agents);
  return { version: version as OrganizationRuntimeConfig["version"], host, agents };
}

/** The wake text bound a parsed configuration admits on its control API. */
export function wakeTextLimit(config: Pick<OrganizationRuntimeConfig, "host">): number { return config.host.maxWakeTextBytes ?? ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES; }

export function parseOrganizationRuntimeWakeRequest(value: unknown, maxTextBytes = ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES): OrganizationRuntimeWakeRequest {
  const request = object(snapshot(value, "wake request"), "wake request");
  exact(request, ["token", "agentId", "event"], "wake request");
  const event = object(request.event, "wake request.event");
  exact(event, ["version", "id", "kind", "text", "occurredAt"], "wake request.event");
  if (string(event.version, "wake request.event.version") !== "noopolis.daimon.wake.v1") throw new TypeError("wake request.event.version is not supported");
  const kind = string(event.kind, "wake request.event.kind");
  if (kind !== "manual" && kind !== "message" && kind !== "schedule" && kind !== "external") throw new TypeError("wake request.event.kind is not supported");
  // A declared wider bound replaces the shared string bound for the wake text alone.
  const text = typeof event.text === "string" && maxTextBytes > ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES ? event.text : string(event.text, "wake request.event.text");
  if (Buffer.byteLength(text, "utf8") > maxTextBytes) throw new TypeError("wake request.event.text exceeds the wake text limit");
  return { token: request.token === undefined ? undefined : string(request.token, "wake request.token"), agentId: nonEmpty(request.agentId, "wake request.agentId"), event: { version: "noopolis.daimon.wake.v1", id: nonEmpty(event.id, "wake request.event.id"), kind, text, occurredAt: rfc3339(event.occurredAt) } };
}

export function validateOrganizationRuntimeConfig(value: unknown): value is OrganizationRuntimeConfig {
  try { parseOrganizationRuntimeConfig(value); return true; } catch { return false; }
}

export const isOrganizationRuntimeConfig = validateOrganizationRuntimeConfig;

function parseAgent(value: unknown, label: string, v2: boolean): OrganizationRuntimeAgentConfig {
  const agent = object(value, label);
  exactOptional(agent, v2 ? ["id", "name", "instructions", "workspacePath", "runtimeHomePath", "engine", "schedule"] : ["id", "name", "instructions", "workspacePath", "runtimeHomePath", "engine"], ["mcp", "moltnet", "memory", "attention", "recording"], label);
  return {
    id: nonEmpty(agent.id, `${label}.id`), name: nonEmpty(agent.name, `${label}.name`), instructions: nonEmpty(agent.instructions, `${label}.instructions`, ORGANIZATION_RUNTIME_MAX_INSTRUCTIONS_CODEPOINTS), workspacePath: absolute(agent.workspacePath, `${label}.workspacePath`), runtimeHomePath: absolute(agent.runtimeHomePath, `${label}.runtimeHomePath`), engine: engine(agent.engine, `${label}.engine`),
    ...(agent.attention === undefined ? {} : { attention: parseAttention(agent.attention) }),
    ...(agent.recording === undefined ? {} : { recording: parseRecording(agent.recording) }),
    ...(v2 ? { schedule: schedule(agent.schedule, `${label}.schedule`) } : {}),
    ...(agent.mcp === undefined ? {} : { mcp: mcpServers(agent.mcp, `${label}.mcp`) }),
    ...(agent.moltnet === undefined ? {} : { moltnet: moltnet(agent.moltnet, `${label}.moltnet`) }),
    ...(agent.memory === undefined ? {} : { memory: memory(agent.memory, `${label}.memory`) })
  };
}

function mcpServers(value: unknown, label: string): OrganizationRuntimeAgentConfig["mcp"] {
  const rows = array(value, label); if (rows.length > 8) throw new TypeError(`${label} exceeds server limit`);
  const names = new Set<string>();
  return rows.map((value, index) => {
    const item = object(value, `${label}[${index}]`); exactOptional(item, ["name", "transport", "args", "env", "tools"], ["command", "url", "authSecretEnv"], `${label}[${index}]`);
    const name = nonEmpty(item.name, `${label}[${index}].name`); if (names.has(name)) throw new TypeError(`${label} has duplicate name`); names.add(name);
    const transport = string(item.transport, `${label}[${index}].transport`); if (!["stdio", "sse", "streamable_http"].includes(transport)) throw new TypeError(`${label} transport is invalid`);
    const args = array(item.args, `${label}[${index}].args`).map((entry) => string(entry, `${label}.args`)); if (args.length > 32) throw new TypeError(`${label} args exceed limit`);
    const envInput = object(item.env, `${label}[${index}].env`); const env = Object.fromEntries(Object.entries(envInput).map(([key, entry]) => [envName(key, `${label}.env key`), string(entry, `${label}.env.${key}`)]));
    const tools = array(item.tools, `${label}[${index}].tools`).map((entry) => nonEmpty(entry, `${label}.tools`)); if (tools.length === 0 || tools.length > 32 || new Set(tools).size !== tools.length) throw new TypeError(`${label} tools are invalid`);
    const command = item.command === undefined ? undefined : absolute(item.command, `${label}.command`); const url = item.url === undefined ? undefined : nonEmpty(item.url, `${label}.url`);
    if ((transport === "stdio") !== (command !== undefined) || (transport === "stdio") === (url !== undefined)) throw new TypeError(`${label} endpoint is invalid`);
    if (url !== undefined) { const parsed = new URL(url); if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost"].includes(parsed.hostname))) throw new TypeError(`${label}.url must be HTTPS or loopback HTTP`); }
    return { name, transport: transport as "stdio" | "sse" | "streamable_http", args, env, tools, ...(command ? { command } : {}), ...(url ? { url } : {}), ...(item.authSecretEnv === undefined ? {} : { authSecretEnv: envName(item.authSecretEnv, `${label}.authSecretEnv`) }) };
  });
}

function moltnet(value: unknown, label: string): NonNullable<OrganizationRuntimeAgentConfig["moltnet"]> {
  const item = object(value, label); exact(item, ["cliPath", "configPath", "networks"], label);
  const networks = array(item.networks, `${label}.networks`).map((value, index) => { const row = object(value, `${label}.networks[${index}]`); exact(row, ["id", "rooms", "dms"], `${label}.networks[${index}]`); return { id: nonEmpty(row.id, `${label}.id`), rooms: array(row.rooms, `${label}.rooms`).map((room) => nonEmpty(room, `${label}.room`)), dms: row.dms === true }; });
  if (networks.length > 16 || new Set(networks.map((entry) => entry.id)).size !== networks.length) throw new TypeError(`${label}.networks are invalid`);
  return { cliPath: absolute(item.cliPath, `${label}.cliPath`), configPath: absolute(item.configPath, `${label}.configPath`), networks };
}

function memory(value: unknown, label: string): NonNullable<OrganizationRuntimeAgentConfig["memory"]> {
  const item = object(value, label); exactOptional(item, ["runtimeHomePath"], ["source", "tokenBudget"], label);
  return {
    runtimeHomePath: absolute(item.runtimeHomePath, `${label}.runtimeHomePath`),
    ...(item.source === undefined ? {} : { source: nonEmpty(item.source, `${label}.source`) }),
    ...(item.tokenBudget === undefined ? {} : { tokenBudget: tokenBudget(item.tokenBudget, `${label}.tokenBudget`) })
  };
}

function tokenBudget(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1_000_000) throw new TypeError(`${label} must be an integer between 1 and 1000000`);
  return value;
}

function schedule(value: unknown, label: string): OrganizationRuntimeSchedule {
  const input = object(value, label); const kind = string(input.kind, `${label}.kind`);
  if (kind === "disabled") { exact(input, ["kind"], label); return { kind }; }
  if (kind === "every") {
    exactOptional(input, ["kind", "interval_ms", "prompt"], ["jitter_seconds"], label);
    if (typeof input.interval_ms !== "number" || !Number.isInteger(input.interval_ms) || input.interval_ms < 1 || input.interval_ms > ORGANIZATION_RUNTIME_MAX_SCHEDULE_INTERVAL_MS) throw new TypeError(`${label}.interval_ms is outside its bound`);
    return { kind, interval_ms: input.interval_ms, prompt: nonEmpty(input.prompt, `${label}.prompt`), ...jitterSeconds(input.jitter_seconds, label) };
  }
  if (kind === "cron") {
    exactOptional(input, ["kind", "cron", "timezone", "prompt"], ["jitter_seconds"], label);
    const cron = nonEmpty(input.cron, `${label}.cron`).trim().replace(/\s+/gu, " ");
    if (!validCron(cron) || !cronCalendarPossible(cron)) throw new TypeError(`${label}.cron is invalid or impossible`);
    const timezone = nonEmpty(input.timezone, `${label}.timezone`);
    try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { throw new TypeError(`${label}.timezone is not an IANA timezone`); }
    return { kind, cron, timezone, prompt: nonEmpty(input.prompt, `${label}.prompt`), ...jitterSeconds(input.jitter_seconds, label) };
  }
  throw new TypeError(`${label}.kind is not supported`);
}

function jitterSeconds(value: unknown, label: string): { jitter_seconds?: number } {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > ORGANIZATION_RUNTIME_MAX_SCHEDULE_JITTER_SECONDS) throw new TypeError(`${label}.jitter_seconds is outside its bound`);
  return { jitter_seconds: value };
}

function validCron(value: string): boolean {
  const fields = value.split(/\s+/u);
  return fields.length === 5 && fields.every((field, index) => validCronField(field, CRON_FIELD_BOUNDS[index]!));
}

function validCronField(field: string, [minimum, maximum]: readonly [number, number]): boolean {
  return field.split(",").every((part) => {
    const pieces = part.split("/");
    const step = Number(pieces[1] ?? 1);
    if (pieces.length > 2 || !pieces[0] || (pieces[1] !== undefined && !/^\d+$/u.test(pieces[1])) || !Number.isSafeInteger(step) || step < 1) return false;
    const range = pieces[0]!;
    if (range === "*") return true;
    const bounds = range.split("-");
    if (bounds.length > 2 || !bounds.every((bound) => /^\d+$/u.test(bound))) return false;
    const first = Number(bounds[0]); const last = Number(bounds[1] ?? bounds[0]);
    return first >= minimum && last <= maximum && first <= last;
  });
}

function cronCalendarPossible(cron: string): boolean {
  const fields = cron.split(/\s+/u).map((field, index) => cronValues(field, CRON_FIELD_BOUNDS[index]!));
  for (let year = 2000; year < 2400; year += 1) for (const month of fields[3]!) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (const day of fields[2]!) if (day <= days && fields[4]!.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) return true;
  }
  return false;
}

function cronValues(field: string, [minimum, maximum]: readonly [number, number]): number[] {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    const [range, rawStep] = part.split("/"); const step = Number(rawStep ?? 1);
    const bounds = range === "*" ? [minimum, maximum] : range!.split("-").map(Number);
    for (let value = bounds[0]!; value <= (bounds[1] ?? bounds[0]!); value += step) result.add(value === 7 && maximum === 7 ? 0 : value);
  }
  return [...result];
}

function engine(value: unknown, label: string): OrganizationRuntimeEngineIntent {
  const input = object(value, label); const kind = string(input.kind, `${label}.kind`);
  if (!ENGINE_KINDS.has(kind)) throw new TypeError(`${label}.kind is not a supported engine`);
  return getEngineHandler(kind as OrganizationRuntimeEngineKind).parseConfig(input, label, { object, string, nonEmpty, exact });
}

function snapshot(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError(`${label} must be JSON data`); return value; }
  if (typeof value !== "object") throw new TypeError(`${label} must be JSON data`);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError(`${label} must contain only indexed data properties`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label}[${String(key)}] must be an enumerable data property`);
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) throw new TypeError(`${label}[${index}] must be a present record`);
      result.push(snapshot(descriptor.value, `${label}[${index}]`));
    }
    return result;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  const result: RecordValue = Object.create(null) as RecordValue;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol properties`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) throw new TypeError(`${label}.${key} must be an enumerable data property`);
    result[key] = snapshot(descriptor.value, `${label}.${key}`);
  }
  return result;
}

function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError(`${label} must be a plain own-properties object`);
  return value as RecordValue;
}
function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`); return value; }
function exact(value: RecordValue, expected: readonly string[], label: string): void { const extras = Object.keys(value).filter((key) => !expected.includes(key)); const missing = expected.filter((key) => !Object.hasOwn(value, key)); if (extras.length || missing.length) throw new TypeError(`${label} must contain exactly ${expected.join(", ")}`); }
function exactOptional(value: RecordValue, required: readonly string[], optional: readonly string[], label: string): void { const extras = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key)); const missing = required.filter((key) => !Object.hasOwn(value, key)); if (extras.length || missing.length) throw new TypeError(`${label} has invalid fields`); }
function isolated(agents: readonly OrganizationRuntimeAgentConfig[]): void { const paths = agents.flatMap((agent) => [{ agentId: agent.id, kind: "workspacePath", value: agent.workspacePath }, { agentId: agent.id, kind: "runtimeHomePath", value: agent.runtimeHomePath }]); for (let left = 0; left < paths.length; left += 1) for (let right = left + 1; right < paths.length; right += 1) { const first = paths[left]!; const second = paths[right]!; if (first.value === second.value || first.value.startsWith(`${second.value}/`) || second.value.startsWith(`${first.value}/`)) throw new TypeError(`agents ${first.agentId}.${first.kind} and ${second.agentId}.${second.kind} must not overlap`); } }
/**
 * A declared bank may sit inside its own agent's runtime home, or be shared
 * verbatim by another agent's declared bank; it must never reach into another
 * agent's private roots, and it must never sit inside its own agent's
 * model-writable workspace (the bash tool's cwd), which would let the sandboxed
 * model tamper with its own ledger and bypass Mneme's policy layer entirely.
 */
function isolatedMemory(agents: readonly OrganizationRuntimeAgentConfig[]): void {
  for (const agent of agents) {
    if (agent.memory === undefined) continue;
    const value = agent.memory.runtimeHomePath;
    if (value === agent.workspacePath || value.startsWith(`${agent.workspacePath}/`) || agent.workspacePath.startsWith(`${value}/`)) throw new TypeError(`agent ${agent.id}.memory.runtimeHomePath and ${agent.id}.workspacePath must not overlap`);
    for (const peer of agents) {
      if (peer.id === agent.id) continue;
      for (const [kind, peerValue] of [["workspacePath", peer.workspacePath], ["runtimeHomePath", peer.runtimeHomePath]] as const) {
        if (value === peerValue || value.startsWith(`${peerValue}/`) || peerValue.startsWith(`${value}/`)) throw new TypeError(`agent ${agent.id}.memory.runtimeHomePath and ${peer.id}.${kind} must not overlap`);
      }
    }
  }
}
function string(value: unknown, label: string, maxCodepoints: number = ORGANIZATION_RUNTIME_MAX_STRING_CODEPOINTS): string { if (typeof value !== "string") throw new TypeError(`${label} must be a string`); if (Buffer.byteLength(value, "utf8") > ORGANIZATION_RUNTIME_MAX_STRING_BYTES || Array.from(value).length > maxCodepoints) throw new TypeError(`${label} exceeds the runtime string limit`); return value; }
function nonEmpty(value: unknown, label: string, maxCodepoints?: number): string { const result = string(value, label, maxCodepoints); if (!result.trim()) throw new TypeError(`${label} must not be empty`); return result; }
function absolute(value: unknown, label: string): string { const result = nonEmpty(value, label); if (!path.posix.isAbsolute(result)) throw new TypeError(`${label} must be an absolute POSIX path`); const normalized = path.posix.normalize(result); if (normalized === "/") throw new TypeError(`${label} must not overlap filesystem root`); return normalized.replace(/\/+$/, ""); }
function envName(value: unknown, label: string): string { const result = nonEmpty(value, label); if (!ENV_NAME.test(result)) throw new TypeError(`${label} must be a safe environment variable name`); return result; }
function wakeTextBound(value: unknown): number { if (typeof value !== "number" || !Number.isInteger(value) || value < ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES || value > ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES_CEILING) throw new TypeError(`config.host.maxWakeTextBytes must be an integer between ${ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES} and ${ORGANIZATION_RUNTIME_MAX_WAKE_TEXT_BYTES_CEILING}`); return value; }
function port(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535) throw new TypeError(`${label} must be an integer between 1 and 65535`); return value; }
function size(value: unknown): void { const serialized = JSON.stringify(value); if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > ORGANIZATION_RUNTIME_MAX_CONFIG_BYTES) throw new TypeError("config exceeds the runtime byte limit"); }
function rfc3339(value: unknown): string { const result = nonEmpty(value, "wake request.event.occurredAt"); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result) || Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) throw new TypeError("wake request.event.occurredAt must be an exact RFC3339 timestamp"); return result; }
import path from "node:path";
