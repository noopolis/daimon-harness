/**
 * A declared MCP server that answers the way real ones do.
 *
 * The previous fixture exposed one tool that always returned a short text
 * `content` and never failed, never returned `structuredContent`, and never
 * exceeded a bound — so every test passed against a server that could not
 * exercise a single one of the paths where Daimon was dropping the payload.
 * The tools below cover the combinations an agent actually meets: content only,
 * structured only, both, an argument-shape refusal carrying its own reason, a
 * business-rule refusal, and a result larger than the tool result bound.
 *
 * `DAIMON_TEST_MCP_TOOLS` selects which of them this process exposes, because
 * `productionAgentTools.ts` refuses a server that lists a tool the agent did not
 * declare — the guard stays exercised while each test declares only what it needs.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const text = (value) => ({ content: [{ type: "text", text: value }] });

const TOOLS = {
  task_clock: {
    description: "Reports only the task clock environment",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    call: () => ({ structuredContent: Object.fromEntries([
      "NOOPOLIS_TASK_CLOCK", "MNEME_CLOCK_ORIGIN", "MNEME_CLOCK_ANCHOR_MS",
      "FAKETIME", "FAKETIME_DONT_FAKE_MONOTONIC", "LD_PRELOAD"
    ].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])) })
  },
  /** Content only, and the original fixture's behaviour, unchanged. */
  checkpoint: {
    description: "Records one bounded checkpoint",
    inputSchema: { type: "object", additionalProperties: false, required: ["phase"], properties: { phase: { type: "string" } } },
    async call(args) {
      await writeFile(path.join(process.env.HOME, "mcp-home-writable"), "ok");
      return text(`checkpoint:${args.phase}:home=${process.env.HOME}`);
    }
  },

  /** Structured only, behind a declared output schema, with no `content` at all. */
  desk_status: {
    description: "Reports the desk status as structured content only",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["open", "editor"], properties: { open: { type: "boolean" }, editor: { type: "string" } } },
    call: () => ({ structuredContent: { open: true, editor: "irene", queue: ["draft-1", "draft-2"] } })
  },

  /** Both channels, the spec's recommended mirroring for a schema-bearing tool. */
  wire_summary: {
    description: "Summarises the wire in both channels",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: { type: "object", required: ["headline_count"], properties: { headline_count: { type: "number" } } },
    call: () => ({
      content: [{ type: "text", text: "3 headlines on the wire: strike, budget, weather" }],
      structuredContent: { headline_count: 3, headlines: ["strike", "budget", "weather"] }
    })
  },

  /**
   * The shape of the tool an organization once spent 17.6M tokens guessing at.
   *
   * Its input schema is permissive enough that a wrong call reaches the server,
   * and the server refuses it with `isError: true` and a sentence naming the
   * field that was missing and the shape it wanted. That sentence is the entire
   * difference between one corrected call and an unbounded retry loop.
   */
  file_article: {
    description: "Files an article to the desk",
    inputSchema: { type: "object", additionalProperties: true, properties: { headline: { type: "string" }, body: { type: "string" }, section: { type: "string" } } },
    call(args) {
      if (typeof args.headline !== "string" || args.headline.length === 0) {
        return { isError: true, content: [{ type: "text", text: "file_article: 'headline' is required and must be a non-empty string. Expected {headline: string, body: string, section: \"news\"|\"opinion\"}." }] };
      }
      if (args.section !== "news" && args.section !== "opinion") {
        return {
          isError: true,
          content: [{ type: "text", text: `file_article: section ${JSON.stringify(args.section ?? null)} is not one of "news" or "opinion".` }],
          structuredContent: { code: "unknown_section", allowed: ["news", "opinion"] }
        };
      }
      return { content: [{ type: "text", text: `filed:${args.headline}` }], structuredContent: { filed: true, headline: args.headline, section: args.section } };
    }
  },

  /** An error result with no explanation at all, which must still read as a failure. */
  silent_failure: {
    description: "Fails without saying why",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    call: () => ({ isError: true, content: [] })
  },

  /** A result several times the tool result bound, in both channels. */
  archive_dump: {
    description: "Returns the whole archive, which is far larger than the bound",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    call: () => ({
      content: [{ type: "text", text: `ARCHIVE-HEAD ${"a".repeat(120_000)}` }],
      structuredContent: { entries: Array.from({ length: 4_000 }, (_index, position) => ({ id: position, body: "b".repeat(40) })) }
    })
  }
};

const exposed = (process.env.DAIMON_TEST_MCP_TOOLS ?? "checkpoint").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
for (const name of exposed) if (TOOLS[name] === undefined) throw new Error(`unknown fixture tool ${name}`);

const server = new Server({ name: "daimon-test-fixture", version: "1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: exposed.map((name) => ({
    name,
    description: TOOLS[name].description,
    inputSchema: TOOLS[name].inputSchema,
    ...(TOOLS[name].outputSchema === undefined ? {} : { outputSchema: TOOLS[name].outputSchema })
  }))
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => await TOOLS[request.params.name].call(request.params.arguments ?? {}));
await server.connect(new StdioServerTransport());
