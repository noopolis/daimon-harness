import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { OrganizationRuntimeAgentConfig, OrganizationRuntimeMcpServer } from "./organizationRuntime.js";
import { moltnetOperationResult, readMoltnetPages } from "./moltnetMachineRead.js";
import { McpToolCallError, MCP_TOOL_RESULT_MAX_BYTES, renderMcpToolResult, replayMcpReceipt, type McpUpstreamResult } from "./mcpToolResult.js";
import { ensureRuntimeHomeDirectory } from "./runtimeHomeLayout.js";
import { capToolResult, resolveExemptToolNames, resolveToolResultMaxBytes, TOOL_OUTPUT_DIRECTORY_NAME } from "./toolResultSpill.js";
import { cliChildEnvironment } from "../pi/cliEnvironment.js";
import { taskClockChildEnvironment, taskClockTimestamp } from "./taskClock.js";
import type { PiWakeEnvironmentContextRef } from "../pi/piAgentWakeSupport.js";

const MAX_RESULT = 65_536; const TIMEOUT = 10_000;

/**
 * Action and delivery identifiers are prefixed with a hyphen, never a colon.
 *
 * Moltnet's machine protocol rejects any identifier that parses as a scoped
 * agent id, and `ParseScopedAgentID` treats *every* `left:right` string as one
 * (`moltnet/pkg/protocol/identity.go`). A `daimon:<digest>` delivery id
 * therefore failed `delivery_id must be a local id`, and the CLI answered
 * `error: invalid request` for every send an agent ever attempted.
 */
const DAIMON_ACTION_ID_PREFIX = "daimon-";

export async function createProductionAgentTools(agent: OrganizationRuntimeAgentConfig, wakeContext: PiWakeEnvironmentContextRef = {}): Promise<ToolDefinition[]> {
  taskClockChildEnvironment();
  for (const server of agent.mcp ?? []) taskClockChildEnvironment(server.env);
  await ensureRuntimeHomeDirectory(agent.runtimeHomePath, "tool-state");
  // Resolved once, at agent start: a malformed bound is a configuration error
  // that should refuse the agent, not a surprise thrown from the middle of a
  // tool call the model is waiting on.
  const cap = { maxBytes: resolveToolResultMaxBytes(), exempt: resolveExemptToolNames() } as const;
  const tools = [...await Promise.all((agent.mcp ?? []).map((server) => mcpTools(agent, server, wakeContext, cap)))].flat();
  if (agent.moltnet !== undefined) tools.push(moltnetTool(agent, wakeContext), moltnetReadTool(agent));
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new Error("compiled cognition tool names collide");
  return tools;
}

async function mcpTools(agent: OrganizationRuntimeAgentConfig, server: OrganizationRuntimeMcpServer, wakeContext: PiWakeEnvironmentContextRef, cap: Readonly<{ maxBytes: number; exempt: ReadonlySet<string> }>): Promise<ToolDefinition[]> {
  const { client, close } = await connect(agent, server); const listed = await client.listTools(undefined, { timeout: TIMEOUT });
  if (Buffer.byteLength(JSON.stringify(listed)) > MAX_RESULT) { await close(); throw new Error(`MCP server ${server.name} tool list exceeds bound`); }
  const available = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const undeclared = [...available.keys()].filter((name) => !server.tools.includes(name));
  if (undeclared.length > 0) { await close(); throw new Error(`MCP server ${server.name} exposed undeclared tools`); }
  const missing = server.tools.filter((name) => !available.has(name)); if (missing.length > 0) { await close(); throw new Error(`MCP server ${server.name} omitted declared tools`); }
  await close();
  return server.tools.map((name) => {
    const declared = available.get(name)!;
    return {
      name: mcpToolName(server.name, name),
      label: `${server.name}: ${name}`,
      description: declared.description ?? `Call declared MCP tool ${server.name}/${name}`,
      parameters: declared.inputSchema as ToolDefinition["parameters"],
      async execute(_id, params) {
        if (!wakeContext.current) throw new Error("MCP call requires an active wake");
        const actionId = `${DAIMON_ACTION_ID_PREFIX}${createHash("sha256").update(JSON.stringify([wakeContext.current, agent.id, server.name, name, params])).digest("hex")}`;
        const prior = await priorReceipt(agent, actionId);
        if (prior !== undefined) { const replayed = replayMcpReceipt(server.name, name, prior); return { content: replayed.content as never, details: replayed.details }; }
        const active = await connect(agent, server);
        try {
          const result = await active.client.callTool({ name, arguments: params as Record<string, unknown> }, undefined, { timeout: TIMEOUT });
          const bytes = JSON.stringify(result);
          const envelope = { kind: "mcp", agent_id: agent.id, engine: agent.engine.kind, delivery_id: actionId, server: server.name, tool: name, digest: digest(bytes) };
          let rendered;
          try {
            // The SDK types this as a union with the pre-schema compatibility shape;
            // only the three fields `McpUpstreamResult` names are ever read.
            rendered = renderMcpToolResult({ server: server.name, tool: name, result: result as McpUpstreamResult, maxBytes: MCP_TOOL_RESULT_MAX_BYTES });
            // Every tool result stays in the transcript for every *subsequent*
            // model request of the wake, so one oversized answer is re-billed
            // once per remaining request. Above the bound the full payload goes
            // to disk and the model gets head+tail plus the path
            // (`toolResultSpill.ts`); at or below it, this returns `rendered`
            // itself and the passthrough contract is untouched.
            rendered = await capToolResult({
              toolName: mcpToolName(server.name, name),
              rendered,
              result: result as McpUpstreamResult,
              maxBytes: cap.maxBytes,
              exempt: cap.exempt,
              spillDirectory: path.join(agent.runtimeHomePath, TOOL_OUTPUT_DIRECTORY_NAME),
              spillId: actionId
            });
          } catch (error) {
            // The server's own reason is the receipt's payload as much as the
            // model's: a replayed failure has to fail for the same stated cause.
            if (error instanceof McpToolCallError) await receipt(agent, { ...envelope, is_error: true, error: error.reason });
            throw error;
          }
          await receipt(agent, { ...envelope, is_error: false, result: { content: rendered.content, details: rendered.details }, ...(rendered.truncated ? { truncated: true } : {}) });
          return { content: rendered.content as never, details: rendered.details };
        } finally { await active.close(); }
      }
    } as ToolDefinition;
  });
}

/**
 * Reading a declared room is a native Moltnet machine operation. Without it an agent can
 * only learn what a wake pushed at it, so any role that weighs several peers' messages
 * has to be woken once per message instead of reading the room once.
 *
 * The whole payload goes in `details` as well as `content`, matching every other
 * Daimon tool (`memoryTools.ts`, `worldTools.ts`). This tool was written by
 * copying `moltnet_send`, whose useful payload genuinely *is* its details
 * (`{"accepted":true}`) — but the MCP mount lowers `details` to
 * `structuredContent` (`src/mcp/toolServer.ts`) and the engines render that in
 * preference to `content`, so a read that put its messages only in `content`
 * handed the model a bare `{"messages":5}` and dropped every message and the
 * page cursor. It looked like a confused agent for a night; it was an empty tool.
 */
function moltnetReadTool(agent: OrganizationRuntimeAgentConfig): ToolDefinition {
  return {
    name: "moltnet_read", label: "Read a scoped Moltnet room or DM", description: "Read recent messages from one room or DM declared for this agent.",
    parameters: { type: "object", additionalProperties: false, required: ["network", "target"], properties: { network: { type: "string" }, target: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, before: { type: "string" }, after: { type: "string" } } },
    async execute(_id, params) {
      const input = params as { network: string; target: string; limit?: number; before?: string; after?: string };
      const network = agent.moltnet!.networks.find((entry) => entry.id === input.network);
      if (network === undefined) throw new Error("Moltnet action exceeds declared scope");
      const [kind, target] = input.target.split(":", 2);
      if ((kind === "room" && !network.rooms.includes(target ?? "")) || (kind === "dm" && !network.dms) || !target || !["room", "dm"].includes(kind ?? "")) throw new Error("Moltnet target is not declared");
      const read = await readMoltnetPages({
        requested: input.limit ?? 20, maxBytes: MAX_RESULT,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        fetch: (request) => moltnetReadPage(agent, input.network, kind!, target, request)
      });
      const payload = {
        target: read.target ?? { kind, id: target },
        messages: read.messages,
        message_count: read.messages.length,
        page: {
          has_more: read.hasMore,
          ...(read.nextBefore === undefined ? {} : { next_before: read.nextBefore }),
          ...(read.nextAfter === undefined ? {} : { next_after: read.nextAfter })
        },
        ...(read.truncated === undefined ? {} : { truncated: read.truncated })
      };
      const bytes = JSON.stringify(payload); if (Buffer.byteLength(bytes) > MAX_RESULT) throw new Error("Moltnet read result exceeds bound");
      return { content: [{ type: "text", text: bytes }], details: payload };
    }
  } as ToolDefinition;
}

/** One `machine` read request, unwrapped onto the shape the pager consumes. */
async function moltnetReadPage(agent: OrganizationRuntimeAgentConfig, networkId: string, kind: string, target: string, request: { limit: number; before?: string; after?: string }) {
  const correlationId = `${DAIMON_ACTION_ID_PREFIX}${createHash("sha256").update(JSON.stringify([agent.id, networkId, kind, target, request.limit, request.before ?? "", request.after ?? ""])).digest("hex")}`;
  const response = await machine(agent.moltnet!.cliPath, agent.moltnet!.configPath, networkId, {
    version: "moltnet.machine.v1", correlation_id: correlationId, operation: "read",
    read: { target: { kind, id: target }, limit: request.limit, ...(request.before === undefined ? {} : { before: request.before }), ...(request.after === undefined ? {} : { after: request.after }) }
  });
  const result = moltnetOperationResult(response, "read", "read") as { target?: unknown; page?: { messages?: unknown[]; page?: { has_more?: unknown; next_before?: unknown; next_after?: unknown } } } | undefined;
  if (result?.page?.messages === undefined) throw new Error("Moltnet read was not accepted");
  const info = result.page.page ?? {};
  return {
    ...(result.target === undefined ? {} : { target: result.target }),
    messages: result.page.messages,
    hasMore: info.has_more === true,
    ...(typeof info.next_before === "string" ? { nextBefore: info.next_before } : {}),
    ...(typeof info.next_after === "string" ? { nextAfter: info.next_after } : {})
  };
}

function moltnetTool(agent: OrganizationRuntimeAgentConfig, wakeContext: PiWakeEnvironmentContextRef): ToolDefinition {
  return {
    name: "moltnet_send", label: "Send a scoped Moltnet message", description: "Send to one room or DM declared for this agent.",
    parameters: { type: "object", additionalProperties: false, required: ["network", "target", "text"], properties: { network: { type: "string" }, target: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 2048 } } },
    async execute(_id, params) {
      const input = params as { network: string; target: string; text: string }; const network = agent.moltnet!.networks.find((entry) => entry.id === input.network);
      if (network === undefined || Buffer.byteLength(input.text) > 2_048) throw new Error("Moltnet action exceeds declared scope");
      const [kind, target] = input.target.split(":", 2); if ((kind === "room" && !network.rooms.includes(target ?? "")) || (kind === "dm" && !network.dms) || !target || !["room", "dm"].includes(kind ?? "")) throw new Error("Moltnet target is not declared");
      if (!wakeContext.current) throw new Error("Moltnet send requires an active wake");
      const deliveryId = `${DAIMON_ACTION_ID_PREFIX}${createHash("sha256").update(JSON.stringify([wakeContext.current, agent.id, input.network, input.target, input.text])).digest("hex")}`;
      const prior = await priorReceipt(agent, deliveryId); if (prior !== undefined) { wakeContext.spokeFor = wakeContext.current; const visible = typeof prior.at === "string" ? { ...prior, at: taskClockTimestamp(prior.at) } : prior; return { content: [{ type: "text", text: JSON.stringify(visible) }], details: visible }; }
      const response = await machine(agent.moltnet!.cliPath, agent.moltnet!.configPath, input.network, { version: "moltnet.machine.v1", correlation_id: deliveryId, operation: "send_nudge", send_nudge: { delivery_id: deliveryId, target: { kind, id: target }, body: input.text } });
      const result = moltnetOperationResult(response, "send_nudge", "send") as { accepted?: boolean; message_id?: string } | undefined; if (result?.accepted !== true || typeof result.message_id !== "string") throw new Error("Moltnet send was not accepted");
      await receipt(agent, { kind: "moltnet", agent_id: agent.id, engine: agent.engine.kind, delivery_id: deliveryId, network: input.network, target: input.target, message_id: result.message_id });
      // An explicit send and the bridge's terminal-text fallback share one
      // publication slot (moltnet AGENTS.md); recording that this wake spoke
      // lets the wake-completion path blank the terminal text so it is not
      // echoed as a second message.
      wakeContext.spokeFor = wakeContext.current;
      return { content: [{ type: "text", text: JSON.stringify({ accepted: true, message_id: result.message_id }) }], details: { accepted: true } };
    }
  } as ToolDefinition;
}

async function connect(agent: OrganizationRuntimeAgentConfig, server: OrganizationRuntimeMcpServer): Promise<{ client: Client; close(): Promise<void> }> {
  taskClockChildEnvironment(server.env);
  const client = new Client({ name: "daimon-production", version: "0.2.0" }); const headers: Record<string, string> = server.authSecretEnv === undefined ? {} : { authorization: `Bearer ${requiredSecret(server.authSecretEnv)}` };
  const transport = server.transport === "stdio"
    ? new StdioClientTransport({ command: server.command!, args: [...server.args], env: stringEnvironment({ ...server.env, ...cliChildEnvironment([], agent.runtimeHomePath, { executablePath: server.command }) }) })
    : server.transport === "sse" ? new SSEClientTransport(new URL(server.url!), { requestInit: { headers } })
      : new StreamableHTTPClientTransport(new URL(server.url!), { requestInit: { headers } });
  await client.connect(transport); return { client, close: () => client.close() };
}
function requiredSecret(name: string): string { const value = process.env[name]; if (!value) throw new Error(`required MCP secret ${name} is missing`); return value; }
function receiptPath(agent: OrganizationRuntimeAgentConfig, deliveryId: string): string { return path.join(agent.runtimeHomePath, "tool-state", `${digest(deliveryId).slice(7)}.json`); }
async function receipt(agent: OrganizationRuntimeAgentConfig, value: Record<string, unknown>): Promise<void> { const deliveryId = String(value.delivery_id); const file = receiptPath(agent, deliveryId); const temporary = `${file}.${process.pid}.${Date.now()}.tmp`; const bytes = `${JSON.stringify({ ...value, at: new Date().toISOString() })}\n`; if (Buffer.byteLength(bytes) > MAX_RESULT) throw new Error("tool receipt exceeds bound"); const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } try { await rename(temporary, file); await pruneReceipts(path.dirname(file)); const directory = await open(path.dirname(file), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } catch (error) { await unlink(temporary).catch(() => undefined); throw error; } }
async function pruneReceipts(directory: string): Promise<void> { const candidates = await Promise.all((await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => ({ name, info: await lstat(path.join(directory, name)) }))); if (candidates.some(({ info }) => !info.isFile() || info.nlink !== 1)) throw new Error("tool receipt directory contains an unsafe entry"); for (const candidate of candidates.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs || right.name.localeCompare(left.name)).slice(2048)) await unlink(path.join(directory, candidate.name)); }
async function priorReceipt(agent: OrganizationRuntimeAgentConfig, deliveryId: string): Promise<Record<string, unknown> | undefined> { const file = receiptPath(agent, deliveryId); let handle; try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } try { const entry = await handle.stat(); if (!entry.isFile() || entry.size > MAX_RESULT) throw new Error("tool receipt is unsafe or exceeds bound"); const value = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>; if (value.delivery_id !== deliveryId || value.agent_id !== agent.id || value.engine !== agent.engine.kind) throw new Error("tool receipt identity mismatch"); return value; } finally { await handle.close(); } }
/**
 * One request/response exchange with `moltnet machine`.
 *
 * Stdin is held open until the response line arrives. `moltnet machine` treats
 * end-of-input as cancellation of everything still in flight, so ending stdin
 * with the request — as this did — raced the send and lost: the CLI answered
 * `{"error":{"code":"canceled"}}` and no message was ever delivered. The
 * operation is complete once its line is on stdout, so closing stdin there can
 * no longer cancel it.
 */
async function machine(cli: string, config: string, network: string, request: unknown): Promise<Record<string, unknown>> {
  const clockEnvironment = taskClockChildEnvironment();
  return await new Promise((resolve, reject) => {
    const child = spawn(cli, ["machine", "--config", config, "--network", network], { stdio: ["pipe", "pipe", "pipe"], ...(Object.keys(clockEnvironment).length === 0 ? {} : { env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "LD_PRELOAD")), ...clockEnvironment } }) });
    let output = "", error = "", settled = false;
    const settle = (action: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); action(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); settle(() => reject(new Error("Moltnet machine timed out"))); }, TIMEOUT);
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_RESULT) { child.kill("SIGKILL"); settle(() => reject(new Error("Moltnet machine response exceeds bound"))); return; }
      const newline = output.indexOf("\n"); if (newline < 0) return;
      const line = output.slice(0, newline).trim(); if (line.length === 0) return;
      child.stdin.end();
      settle(() => { try { resolve(JSON.parse(line) as Record<string, unknown>); } catch (cause) { reject(cause); } });
      child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.once("error", (cause) => settle(() => reject(cause)));
    child.once("exit", () => settle(() => reject(new Error(`Moltnet machine failed: ${(error.slice(0, 1024) || "no response").trim()}`))));
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
/** The mounted name of one declared MCP tool: the one place it is spelled. */
function mcpToolName(server: string, tool: string): string { return `mcp_${safe(server)}_${safe(tool)}`; }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_]/gu, "_").slice(0, 48); }
function stringEnvironment(value: NodeJS.ProcessEnv): Record<string, string> { return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
