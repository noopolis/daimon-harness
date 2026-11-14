import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPiToolMcpServer, type PiToolTurnCount } from "../mcp/toolServer.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Sessions one wake's mount holds at once: far above any engine's own use, and a bound on a misbehaving client. */
export const MAX_MCP_SESSIONS = 16;

type MountedSession = { server: ReturnType<typeof createPiToolMcpServer>; transport: StreamableHTTPServerTransport };

export const startMcp = async (
  tools: ToolDefinition[],
  maxToolTurns: number | undefined,
  wakeDeadline: number | undefined,
  onToolsMounted: ((tools: readonly ToolDefinition[]) => void) | undefined,
  onStarted: (mount: { endpoint: string; close: () => Promise<void> }) => void
): Promise<{ endpoint: string; close: () => Promise<void> }> => {
  onToolsMounted?.(tools);
  // One wake, one tool-turn budget, any number of client sessions. An engine may connect more than once in a
  // turn: AGY 1.1.22 opens one session to materialize the tool schemas and another for the conversation that
  // calls them. A single-session transport answered the second `initialize` with 400, so the model was told
  // its tools by name and given none of them. Every session gets its own server and transport over the same
  // tools and the same shared count.
  const turns: PiToolTurnCount = { used: 0 };
  const sessions = new Map<string, MountedSession>();
  const pending = new Set<MountedSession>();
  const dispose = async (session: MountedSession): Promise<void> => {
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };
  const refuse = (response: ServerResponse, status: number, message: string): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
  };
  const openSession = async (): Promise<MountedSession> => {
    const server = createPiToolMcpServer(tools, { maxToolTurns, wakeDeadline }, turns);
    const session: MountedSession = { server, transport: new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { pending.delete(session); sessions.set(id, session); },
      onsessionclosed: (id) => { sessions.delete(id); }
    }) };
    pending.add(session);
    await server.connect(session.transport);
    return session;
  };
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const header = request.headers["mcp-session-id"];
    const id = Array.isArray(header) ? header[0] : header;
    const known = id === undefined ? undefined : sessions.get(id);
    if (known !== undefined) return known.transport.handleRequest(request, response);
    if (id !== undefined) return refuse(response, 404, "Session not found");
    if (cancelled) return refuse(response, 503, "MCP mount is closing");
    if (sessions.size + pending.size >= MAX_MCP_SESSIONS) return refuse(response, 503, "Too many MCP sessions for one wake");
    const session = await openSession();
    // Anything but `initialize` is refused by the transport and leaves no session behind.
    response.once("close", () => { if (pending.delete(session)) void dispose(session); });
    return session.transport.handleRequest(request, response);
  };
  const httpServer: Server = createServer((request, response) => {
    void handle(request, response).catch(() => { if (!response.headersSent) refuse(response, 500, "MCP mount failed"); else response.end(); });
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
    await Promise.all([...sessions.values(), ...pending].map(dispose));
    sessions.clear(); pending.clear();
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
