import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest
} from "@modelcontextprotocol/sdk/types.js";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export class McpToolTurnLimitError extends Error {
  public constructor(maxToolTurns: number) {
    super(`McpToolTurnLimitError: maximum ${maxToolTurns} calls per wake`);
    this.name = "McpToolTurnLimitError";
  }
}

export class McpWakeDeadlineError extends Error {
  public constructor() {
    super("McpWakeDeadlineError: wake deadline exceeded");
    this.name = "McpWakeDeadlineError";
  }
}

/**
 * A non-standard request AGY issues during its MCP handshake.
 *
 * Captured live from `agy --print … --output-format stream-json`, the client
 * sends `initialize`, `notifications/initialized`, **`server/discover`**,
 * `tools/list`, `tools/call`. `server/discover` is not in the MCP
 * specification, and the throwaway probe that proved AGY's headless tool
 * calling answered it with `{}`. Codex and Grok never send it.
 *
 * This server answers it the same way that working probe did, rather than the
 * SDK default of `MethodNotFound`, because a refusal here is the one observable
 * difference between this server and the one AGY is known to work against, and
 * the cost of being wrong is that every AGY agent silently loses every tool.
 * The allowance is exactly this one method: any other unknown method still gets
 * `MethodNotFound`, so a genuine protocol mistake is never hidden.
 */
export const AGY_SERVER_DISCOVER_METHOD = "server/discover" as const;

export interface PiToolMcpServerOptions {
  readonly maxToolTurns?: number;
  readonly wakeDeadline?: number;
}

type JsonSchema = Record<string, unknown>;

const jsonSchema = (parameters: unknown): JsonSchema => {
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new TypeError("Pi tool parameters must be a JSON schema object");
  }
  return Object.fromEntries(Object.entries(parameters));
};

const toolResult = (result: { content: CallToolResult["content"]; details?: unknown }): CallToolResult => ({
  content: result.content,
  ...(result.details !== undefined && typeof result.details === "object" && result.details !== null
    ? { structuredContent: Object.fromEntries(Object.entries(result.details)) }
    : {})
});

/** Bound on the rendered Ajv violations, so a pathological schema cannot flood a turn. */
const MAX_SCHEMA_VIOLATION_BYTES = 2_048;

/**
 * Why the arguments were rejected, in the schema's own words.
 *
 * A bare `Invalid arguments for tool X` tells an agent that its call was wrong
 * and nothing about how, which leaves trial and error as the only way to learn
 * a tool's argument shape. Ajv already knows which instance path failed and
 * which keyword it failed on; saying so turns a guessing loop into one
 * correction.
 */
const schemaViolations = (validator: ValidateFunction): string => {
  const rendered = (validator.errors ?? [])
    .map((issue) => `${issue.instancePath === "" ? "(root)" : issue.instancePath} ${issue.message ?? "is invalid"}`.trim())
    .join("; ");
  if (rendered.length === 0) return "the arguments do not match the tool's declared input schema";
  return rendered.length > MAX_SCHEMA_VIOLATION_BYTES ? `${rendered.slice(0, MAX_SCHEMA_VIOLATION_BYTES)}…` : rendered;
};

const toolError = (error: unknown): CallToolResult => ({
  content: [{ type: "text", text: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }],
  isError: true
});

// Pi's ExtensionContext has no meaning outside a Pi session. Mounted tools
// must not read it; this named value documents the explicit absence.
// The MCP mount deliberately has no Pi session context; `never` preserves typed positional checks.
const NO_PI_EXTENSION_CONTEXT = undefined as never;

const validateOptions = (options: PiToolMcpServerOptions): void => {
  if (options.maxToolTurns !== undefined && (!Number.isSafeInteger(options.maxToolTurns) || options.maxToolTurns < 1)) {
    throw new TypeError("maxToolTurns must be a positive safe integer");
  }
  if (options.wakeDeadline !== undefined && !Number.isFinite(options.wakeDeadline)) {
    throw new TypeError("wakeDeadline must be a finite epoch-millisecond deadline");
  }
};

/**
 * Tool turns one wake has spent, shared by every server of that wake's mount: a client that opens several
 * sessions (AGY does) still draws on one `maxToolTurns` budget.
 */
export interface PiToolTurnCount { used: number }

export const createPiToolMcpServer = (
  tools: ToolDefinition[],
  options: PiToolMcpServerOptions,
  turns: PiToolTurnCount = { used: 0 }
): Server => {
  validateOptions(options);
  const server = new Server({ name: "daimon-pi-tools", version: "0.1.2" });
  server.fallbackRequestHandler = async (request) => {
    if (request.method !== AGY_SERVER_DISCOVER_METHOD) {
      throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${request.method}`);
    }
    return {};
  };
  const validators = new Map(tools.map((tool): [string, ValidateFunction] => {
    const schema = jsonSchema(tool.parameters);
    return [tool.name, new Ajv2020({ strict: false }).compile(schema)];
  }));

  server.registerCapabilities({ tools: { listChanged: true } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.label,
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters)
    }))
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
      try {
        if (options.wakeDeadline !== undefined && Date.now() >= options.wakeDeadline) throw new McpWakeDeadlineError();
        if (options.maxToolTurns !== undefined && turns.used >= options.maxToolTurns) throw new McpToolTurnLimitError(options.maxToolTurns);
        const tool = tools.find((candidate) => candidate.name === request.params.name);
        const validator = validators.get(request.params.name);
        if (tool === undefined || validator === undefined) {
          throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}`);
        }
        const args = request.params.arguments ?? {};
        if (!validator(args)) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid arguments for tool ${tool.name}: ${schemaViolations(validator)}`);
        }
        const toolTurn = turns.used += 1;
        // Ajv validated this value against this tool's own schema immediately above.
        const validatedArgs = args as Parameters<typeof tool.execute>[1];
        const deadlineController = options.wakeDeadline === undefined ? undefined : new AbortController();
        const remainingMs = options.wakeDeadline === undefined ? undefined : Math.max(0, options.wakeDeadline - Date.now());
        const deadlineTimer = deadlineController === undefined ? undefined : setTimeout(() => deadlineController.abort(), remainingMs);
        const signal = deadlineController === undefined ? extra.signal
          : extra.signal === undefined ? deadlineController.signal : AbortSignal.any([extra.signal, deadlineController.signal]);
        const deadline = deadlineController === undefined ? undefined : new Promise<never>((_resolve, reject) => {
          deadlineController.signal.addEventListener("abort", () => reject(new McpWakeDeadlineError()), { once: true });
        });
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          const execution = tool.execute(`mcp-tool-turn-${toolTurn}`, validatedArgs, signal, undefined, NO_PI_EXTENSION_CONTEXT);
          result = deadline === undefined ? await execution : await Promise.race([execution, deadline]);
        } finally {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        }
        return toolResult(result);
      } catch (error) {
        return toolError(error);
      }
    }
  );
  return server;
};
