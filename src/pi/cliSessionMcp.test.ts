import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { MAX_MCP_SESSIONS, startMcp } from "./cliSessionMcp.js";

const echo = {
  name: "probe_echo", label: "Echo", description: "Echo a word back.",
  parameters: { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false },
  execute: async (_id: string, args: { word: string }) => ({ content: [{ type: "text", text: `echo:${args.word}` }], details: undefined })
} as unknown as ToolDefinition;

const mount = (maxToolTurns?: number) => startMcp([echo], maxToolTurns, undefined, undefined, () => undefined);
const connect = async (endpoint: string): Promise<Client> => {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return client;
};
const post = (endpoint: string, body: unknown, session?: string) => fetch(endpoint, { method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
  body: JSON.stringify(body) });
const text = (result: unknown): string => ((result as { content: { text: string }[] }).content[0]!).text;

test("a second client session of the same wake gets the same tools and can call them", async () => {
  const mounted = await mount();
  try {
    // AGY opens one session to read the tool schemas and another for the conversation that calls them.
    const first = await connect(mounted.endpoint);
    assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ["probe_echo"]);
    // Mutation guard: a single-session mount answered this second `initialize` with 400 and the model got no tool.
    const second = await connect(mounted.endpoint);
    assert.deepEqual((await second.listTools()).tools.map((tool) => tool.name), ["probe_echo"]);
    assert.equal(text(await second.callTool({ name: "probe_echo", arguments: { word: "two" } })), "echo:two");
    assert.equal(text(await first.callTool({ name: "probe_echo", arguments: { word: "one" } })), "echo:one");
  } finally { await mounted.close(); }
});

test("every session draws on the wake's one tool-turn budget", async () => {
  const mounted = await mount(2);
  try {
    const first = await connect(mounted.endpoint), second = await connect(mounted.endpoint);
    assert.equal(text(await first.callTool({ name: "probe_echo", arguments: { word: "a" } })), "echo:a");
    assert.equal(text(await second.callTool({ name: "probe_echo", arguments: { word: "b" } })), "echo:b");
    const third = await second.callTool({ name: "probe_echo", arguments: { word: "c" } });
    assert.equal(third.isError, true);
    assert.match(text(third), /maximum 2 calls per wake/u);
  } finally { await mounted.close(); }
});

test("a request before initialize leaves no session behind, an unknown session is refused, and sessions are bounded", async () => {
  const mounted = await mount();
  try {
    // AGY's first request is a session-less `server/discover`; it then initializes normally.
    for (let attempt = 0; attempt < MAX_MCP_SESSIONS + 4; attempt++) {
      const discover = await post(mounted.endpoint, { jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
      assert.equal(discover.status, 400); await discover.arrayBuffer();
    }
    const unknown = await post(mounted.endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, "no-such-session");
    assert.equal(unknown.status, 404); await unknown.arrayBuffer();
    const clients: Client[] = [];
    for (let index = 0; index < MAX_MCP_SESSIONS; index++) clients.push(await connect(mounted.endpoint));
    assert.equal((await clients.at(-1)!.listTools()).tools.length, 1);
    await assert.rejects(connect(mounted.endpoint));
  } finally { await mounted.close(); }
});

test("closing the mount ends every session", async () => {
  const mounted = await mount();
  const first = await connect(mounted.endpoint), second = await connect(mounted.endpoint);
  await mounted.close();
  await assert.rejects(first.listTools());
  await assert.rejects(second.listTools());
});
