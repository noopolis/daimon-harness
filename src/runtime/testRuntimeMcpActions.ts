import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readyTaskClockEnvironment } from "./taskClockProcess.js";
import { taskClockChildEnvironment } from "./taskClock.js";

const MAX_CONFIG_BYTES = 65_536; const MAX_ACTIONS = 16; const MAX_ARGUMENT_BYTES = 16_384;
type Server = Readonly<{ id: string; agent_id: string; command: string; args: string[]; tools: string[]; env_names: string[] }>;
type Trigger = Readonly<{ agent_id: string; wake_kind: "manual" | "message" | "schedule" | "external"; text_sha256: string; delivery_id?: string }>;
type Action = Readonly<{ type: "mcp_call"; trigger: Trigger; server_id: string; tool: string; arguments: Record<string, unknown> }>;
export type ScriptedMcpReceipt = Readonly<{ type: "mcp_call"; delivery_id: string; server_id: string; tool: string; result_digest: string; is_error: boolean }>;

export async function createScriptedMcpActions(value: unknown, configPath: unknown, receiptPath: unknown): Promise<(request: { agentId: string; event: { id: string; kind: string; text: string } }) => Promise<ScriptedMcpReceipt[]>> {
  const actions = parseActions(value); if (actions.length === 0) return async () => [];
  if (!absolute(configPath) || !absolute(receiptPath)) throw new Error("scripted MCP actions require absolute compiled artifact paths");
  const [configStat, receiptStat] = await Promise.all([lstat(configPath), lstat(receiptPath)]); if ([configStat, receiptStat].some((stat) => !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES)) throw new Error("scripted MCP artifact is unsafe");
  const configBytes = await readFile(configPath); const receipt = record(JSON.parse(await readFile(receiptPath, "utf8"))); const servers = parseConfig(JSON.parse(configBytes.toString("utf8")));
  if (receipt.version !== "spawnfile.explicit-test-mcp-receipt.v1" || receipt.artifact_sha256 !== `sha256:${createHash("sha256").update(configBytes).digest("hex")}`) throw new Error("scripted MCP artifact attestation mismatch");
  for (const server of servers.values()) taskClockChildEnvironment(Object.fromEntries(server.env_names.map((name) => [name, "declared"])));
  for (const action of actions) { const server = servers.get(action.server_id); if (!server || server.agent_id !== action.trigger.agent_id || !server.tools.includes(action.tool)) throw new Error("scripted MCP action is not declared"); }
  return async (request) => {
    const receipts: ScriptedMcpReceipt[] = [];
    for (const action of actions.filter((candidate) => matches(candidate.trigger, request))) receipts.push(await call(servers.get(action.server_id)!, action, request.event.id));
    return receipts;
  };
}
async function call(server: Server, action: Action, deliveryId: string): Promise<ScriptedMcpReceipt> {
  const env = Object.fromEntries(server.env_names.map((name) => { const value = process.env[name]; if (value === undefined) throw new Error(`scripted MCP environment ${name} is missing`); return [name, value]; }));
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: readyTaskClockEnvironment({ ...env, ...taskClockChildEnvironment(env) }) as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "daimon-explicit-test-runtime", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools(); if (!listed.tools.some((tool) => tool.name === action.tool) || listed.tools.some((tool) => !server.tools.includes(tool.name))) throw new Error("scripted MCP server tool declaration drift");
    const result = await client.callTool({ name: action.tool, arguments: action.arguments }, undefined, { timeout: 10_000 });
    const bytes = JSON.stringify(result); if (Buffer.byteLength(bytes) > 65_536) throw new Error("scripted MCP result is oversized");
    return { type: "mcp_call", delivery_id: deliveryId, server_id: action.server_id, tool: action.tool, result_digest: createHash("sha256").update(bytes).digest("hex"), is_error: result.isError === true };
  } finally { await client.close().catch(() => undefined); }
}
function parseActions(value: unknown): Action[] {
  if (value === undefined) return []; if (!Array.isArray(value) || value.length > MAX_ACTIONS) throw new Error("invalid scripted cognition actions");
  return value.filter((item) => record(item).type === "mcp_call").map((item) => { const row = record(item); exact(row, ["type", "trigger", "server_id", "tool", "arguments"]); if (!identifier(row.server_id) || !identifier(row.tool)) throw new Error("invalid scripted MCP action"); const trigger = record(row.trigger); exactOptional(trigger, ["agent_id", "wake_kind", "text_sha256"], ["delivery_id"]); if (!identifier(trigger.agent_id) || !["manual", "message", "schedule", "external"].includes(trigger.wake_kind as string) || typeof trigger.text_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(trigger.text_sha256) || (trigger.delivery_id !== undefined && (typeof trigger.delivery_id !== "string" || !/^(?:schedule|moltnet):\S{1,1024}$/u.test(trigger.delivery_id)))) throw new Error("invalid scripted MCP trigger"); const args = record(row.arguments); if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENT_BYTES) throw new Error("scripted MCP arguments are oversized"); return row as unknown as Action; });
}
function parseConfig(value: unknown): Map<string, Server> {
  const root = record(value); exact(root, ["version", "compile_fingerprint", "servers"]); if (root.version !== "spawnfile.explicit-test-mcp.v1" || typeof root.compile_fingerprint !== "string" || !/^sf1:[a-f0-9]{12}$/u.test(root.compile_fingerprint) || !Array.isArray(root.servers) || root.servers.length > 8) throw new Error("invalid scripted MCP config");
  const servers = root.servers.map((value) => { const row = record(value); exact(row, ["id", "agent_id", "command", "args", "tools", "env_names"]); if (!identifier(row.id) || !identifier(row.agent_id) || !absolute(row.command) || !strings(row.args, 16, absolute) || !strings(row.tools, 16, identifier) || !strings(row.env_names, 16, identifier)) throw new Error("invalid scripted MCP server"); return row as unknown as Server; });
  if (new Set(servers.map((server) => server.id)).size !== servers.length) throw new Error("duplicate scripted MCP server"); return new Map(servers.map((server) => [server.id, server]));
}
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("unexpected field"); }
function exactOptional(value: Record<string, unknown>, required: string[], optional: string[]): void { const keys = Object.keys(value); if (required.some((key) => !(key in value)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) throw new Error("unexpected field"); }
function identifier(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/u.test(value); }
function absolute(value: unknown): value is string { return typeof value === "string" && value.startsWith("/") && value.length <= 1024; }
function strings(value: unknown, limit: number, validate: (item: unknown) => boolean): value is string[] { return Array.isArray(value) && value.length <= limit && value.every(validate) && new Set(value).size === value.length; }
function matches(trigger: Trigger, request: { agentId: string; event: { id: string; kind: string; text: string } }): boolean { return (trigger.delivery_id === undefined || trigger.delivery_id === request.event.id) && trigger.agent_id === request.agentId && trigger.wake_kind === request.event.kind && trigger.text_sha256 === createHash("sha256").update(request.event.text).digest("hex"); }
