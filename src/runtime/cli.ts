#!/usr/bin/env node
import { engineHandlers } from "../engines/registry.js";
import type { EngineCliAuthCommand } from "../engines/runtimeHooks.js";
import { mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import path from "node:path";

import { createOrganizationRuntimeHost } from "./organizationRuntimeHost.js";
import { createOrganizationRuntimeControlHost } from "./organizationRuntimeControl.js";
import { parseOrganizationRuntimeConfig, parseOrganizationRuntimeWakeRequest, wakeTextLimit } from "./organizationRuntime.js";
import { runEngineBrokerServiceCli } from "../engines/grok/broker/engineBrokerServiceCli.js";
import { runGatewayCli } from "../gateway/gatewayCli.js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_CONFIG_BYTES = 1_048_576;
const ACCEPTANCE_STORE_ENV = "DAIMON_RUNTIME_ACCEPTANCE_STORE";
const READINESS_RECEIPT_ENV = "DAIMON_RUNTIME_READINESS_RECEIPT";

export async function runOrganizationRuntimeCli(arguments_: readonly string[], environment = process.env): Promise<void> {
  if(arguments_.length===2&&arguments_[0]==="engine-broker"&&arguments_[1]==="serve"){await runEngineBrokerServiceCli();return;}
  if (arguments_[0] === "gateway") { await runGatewayCli(arguments_.slice(1)); return; }
  const command = parseArguments(arguments_);
  const config = parseOrganizationRuntimeConfig(JSON.parse(await readBoundedFile(command.configPath)));
  if (command.kind !== "run") {
    const handler = engineHandlers().find((candidate) => candidate.cliCommandKind === command.kind)!;
    await handler.runCliCommand!(config);
    return;
  }
  const storePath = environment[ACCEPTANCE_STORE_ENV];
  const control = storePath === undefined || !storePath.trim()
    ? undefined
    : createOrganizationRuntimeControlHost(config, { acceptanceStorePath: storePath, controlToken: environment[config.host.controlTokenEnv] });
  const host = control ?? createOrganizationRuntimeHost(config);
  await host.start();

  const server = createServer((request, response) => {
    void handleRequest(request, response, host, control, environment[config.host.controlTokenEnv], wakeTextLimit(config));
  });
  try {
    if (environment[READINESS_RECEIPT_ENV]) await writeReadinessReceipt(environment[READINESS_RECEIPT_ENV]!, config);
    await listen(server, config.host.bindHost, config.host.port);
  } catch (error) {
    await host.stop();
    throw error;
  }
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // Signals can arrive together (Docker stop commonly sends TERM then KILL).
  // Every path shares one shutdown outcome and only the first initiates it.
  let shutdown: Promise<void> | undefined;
  let serverClosed = false;
  const stop = (): Promise<void> => {
    if (shutdown !== undefined) return shutdown;
    const attempt = (async () => {
      if (!serverClosed) {
        await closeServer(server, sockets);
        serverClosed = true;
      }
      await host.stop();
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    })();
    shutdown = attempt;
    void attempt.catch(() => { if (shutdown === attempt) shutdown = undefined; });
    return attempt;
  };
  const onSignal = (): void => { void stop().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "runtime shutdown failed"}\n`); process.exitCode = 1; }); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function writeReadinessReceipt(file: string, config: ReturnType<typeof parseOrganizationRuntimeConfig>): Promise<void> {
  const value = `${JSON.stringify({ version: "noopolis.daimon.readiness-receipt.v1", agents: config.agents.map((agent) => ({ agent_id: agent.id, engine: agent.engine.kind })).sort((left, right) => left.agent_id.localeCompare(right.agent_id)) })}\n`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, "wx", 0o600); try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file); const directory = await open(path.dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); }
}

export function parseOrganizationRuntimeCliArguments(arguments_: readonly string[]): Readonly<{
  configPath: string;
  kind: "run";
}> | EngineCliAuthCommand {
  if (arguments_.length === 3 && arguments_[0] === "run" && arguments_[1] === "--config" && arguments_[2]) {
    return { configPath: arguments_[2], kind: "run" };
  }
  for (const handler of engineHandlers()) {
    const command = handler.parseCliArguments?.(arguments_);
    if (command !== undefined) return command;
  }
  throw new Error("usage: daimon-runtime run --config <path> | daimon-runtime gateway --config <path> | daimon-runtime auth agy login --config <path>");
}

const parseArguments = parseOrganizationRuntimeCliArguments;

async function handleRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  host: ReturnType<typeof createOrganizationRuntimeHost>,
  control: ReturnType<typeof createOrganizationRuntimeControlHost> | undefined,
  expectedToken: string | undefined,
  maxWakeTextBytes: number
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://runtime.invalid");
    if (request.method === "GET" && url.pathname === "/healthz" && url.search === "") {
      return respond(response, 200, { status: "ok" });
    }
    if (!authorized(request, expectedToken)) return respond(response, 401, { error: "unauthorized" });
    if (request.method === "POST" && url.pathname === "/v1/wake") {
      if (request.headers["content-type"] !== "application/json") throw new TypeError("content-type must be application/json");
      const result = await host.wake(parseOrganizationRuntimeWakeRequest({ ...bodyRecord(await readJson(request)), token: expectedToken }, maxWakeTextBytes));
      return respond(response, result.status === "completed" ? 200 : result.status === "failed" ? 502 : 409, result);
    }
    if (request.method === "GET" && url.pathname === "/v1/health") {
      return respond(response, 200, await host.health(parseHealthQuery(url)));
    }
    if (request.method === "GET" && url.pathname === "/v1/activity") {
      return respond(response, 200, await host.activity(parseActivityQuery(url)));
    }
    if (control !== undefined && request.method === "POST" && url.pathname === "/v2/wakes") {
      if (request.headers["content-type"] !== "application/json") throw new TypeError("content-type must be application/json");
      const result = await control.accept({ ...bodyRecord(await readJson(request)), token: expectedToken });
      const status = result.state === "accepted" ? 202 : result.state === "stopped" ? 409 : result.code === "invalid_request" ? 400 : result.code === "unauthorized" ? 401 : 409;
      return respond(response, status, result);
    }
    if (control !== undefined && request.method === "GET" && /^\/v2\/wake-receipts\/[0-9a-f-]+$/iu.test(url.pathname)) {
      assertQuery(url, []);
      const acceptanceId = url.pathname.slice("/v2/wake-receipts/".length);
      const receipt = await control.wakeReceipt(expectedToken, acceptanceId);
      return receipt === undefined ? respond(response, 404, { error: "not_found" }) : respond(response, 200, receipt);
    }
    if (control !== undefined && request.method === "GET" && url.pathname === "/v2/availability") {
      assertQuery(url, []);
      const availability = await control.availability(expectedToken);
      return availability === undefined ? respond(response, 404, { error: "not_found" }) : respond(response, 200, availability);
    }
    if (control !== undefined && request.method === "POST" && (url.pathname === "/v2/drain" || url.pathname === "/v2/resume")) {
      assertQuery(url, []);
      const availability = url.pathname === "/v2/drain" ? await control.drain(expectedToken) : await control.resume(expectedToken);
      return availability === undefined ? respond(response, 404, { error: "not_found" }) : respond(response, 200, availability);
    }
    if (control !== undefined && request.method === "GET" && url.pathname === "/v2/activity") {
      assertQuery(url, []);
      const activity = await control.activityV2(expectedToken);
      return activity === undefined ? respond(response, 404, { error: "not_found" }) : respond(response, 200, activity);
    }
    return respond(response, 404, { error: "not_found" });
  } catch (error) {
    return respond(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
  }
}

function authorized(request: import("node:http").IncomingMessage, token: string | undefined): boolean {
  if (token === undefined || !token.trim()) return false;
  const actual = request.headers.authorization;
  if (actual === undefined) return false;
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(`Bearer ${token}`), digest(actual));
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new TypeError("request body is too large");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("request body must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("request body must be a plain own-properties object");
  return value as Record<string, unknown>;
}

function parseHealthQuery(url: URL): string | undefined {
  assertQuery(url, ["agentId"]);
  return url.searchParams.has("agentId") ? nonBlank(url.searchParams.get("agentId"), "agentId") : undefined;
}

function parseActivityQuery(url: URL): { agentId?: string; cursor?: string; limit: number } {
  assertQuery(url, ["agentId", "cursor", "limit"]);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit)) throw new TypeError("limit must be an integer");
  return {
    ...(url.searchParams.has("agentId") ? { agentId: nonBlank(url.searchParams.get("agentId"), "agentId") } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: nonBlank(url.searchParams.get("cursor"), "cursor") } : {}),
    limit
  };
}

function assertQuery(url: URL, allowed: readonly string[]): void {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) throw new TypeError("query contains an unsupported or duplicate parameter");
    seen.add(key);
  }
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const result = value;
  if (!result.trim()) throw new TypeError(`${label} must not be blank`);
  return result;
}

async function readBoundedFile(filePath: string): Promise<string> {
  if ((await stat(filePath)).size > MAX_CONFIG_BYTES) throw new TypeError("runtime config is too large");
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_CONFIG_BYTES) throw new TypeError("runtime config is too large");
  return bytes.toString("utf8");
}

function respond(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function listen(server: import("node:http").Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

async function closeServer(server: import("node:http").Server, sockets: Set<import("node:net").Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  const timeout = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 10_000);
  try { await closed; } finally { clearTimeout(timeout); }
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : await realpath(process.argv[1]).catch(() => process.argv[1]);

if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  void runOrganizationRuntimeCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "daimon-runtime failed"}\n`);
    process.exitCode = 1;
  });
}
