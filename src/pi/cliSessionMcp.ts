import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPiToolMcpServer } from "../mcp/toolServer.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const startMcp = async (
  tools: ToolDefinition[],
  maxToolTurns: number | undefined,
  wakeDeadline: number | undefined,
  onToolsMounted: ((tools: readonly ToolDefinition[]) => void) | undefined,
  onStarted: (mount: { endpoint: string; close: () => Promise<void> }) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> => {
  onToolsMounted?.(tools);
  const mcpServer = createPiToolMcpServer(tools, { maxToolTurns, wakeDeadline });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  const httpServer: Server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  let lifecycle: "starting" | "listening" | "closing" | "closed" = "starting";
  let cancelled = false;
  let endpoint = "";
  let closePromise: Promise<void> | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve; });
  const close = (): Promise<void> => closePromise ??= (async () => {
    cancelled = true;
    if (lifecycle !== "closed") lifecycle = "closing";
    // `listen()` begins synchronously but its callback is pending. Waiting for
    // startup prevents dispose from returning while that callback can still bind.
    await startupSettled;
    await transport.close().catch(() => undefined);
    await mcpServer.close().catch(() => undefined);
    // `close` only stops accepting and then waits for every open connection,
    // including the ones the transport has no record of and so cannot end (a
    // socket opened before `initialize`, or a client pool's idle keep-alive
    // socket, which relaying a turn through the broker MCP facade leaves
    // behind). That wait is unbounded and sits on the wake's own completion
    // path: measured, one such connection parked a finished broker turn with
    // its result in hand and published nothing. By here this one wake's engine
    // has returned, failed or been cancelled, so anything still connected is a
    // leftover — see `AGENTS.md`, and the facade, which bounds itself the same
    // way.
    if (httpServer.listening) await new Promise<void>((resolve) => { httpServer.close(() => resolve()); httpServer.closeAllConnections(); });
    lifecycle = "closed";
  })();
  const mount = { get endpoint(): string { return endpoint; }, close };
  onStarted(mount);
  let startupError: unknown;
  try {
    if (cancelled) throw new Error("MCP startup was cancelled");
    await mcpServer.connect(transport);
    if (cancelled) throw new Error("MCP startup was cancelled");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      httpServer.once("error", onError);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.off("error", onError);
        // A disposer can run from a Server.prototype.listen interceptor before
        // this callback. Never publish the server as live in that interleaving.
        if (!cancelled) lifecycle = "listening";
        resolve();
      });
    });
    if (cancelled) throw new Error("MCP startup was cancelled");
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("MCP server did not receive an ephemeral port");
    }
    endpoint = `http://127.0.0.1:${address.port}/mcp`;
    return mount;
  } catch (error) {
    startupError = error;
    throw error;
  } finally {
    settleStartup();
    if (cancelled || startupError !== undefined) await close();
  }
};
