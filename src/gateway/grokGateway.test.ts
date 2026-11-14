import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";
import { parseGatewayConfig, GATEWAY_CONFIG_VERSION } from "./config.js";
import { parseGrokAuth, type GrokLogin } from "./grokCredential.js";
import { createGrokRealmOwner } from "./grokRealmOwner.js";
import { createGrokRefresh, GrokRefreshRejected, sweepGrokRefreshScratch } from "./grokRefresh.js";
import { gatewayKeyDigest, GATEWAY_KEY_TABLE_VERSION, parseGatewayKeyTable } from "./keyTable.js";
import { startGatewayServer } from "./server.js";

const GROK_KEY = "synthetic-gateway-grok-key-0001";
const CODEX_KEY = "synthetic-gateway-codex-key-0001";
const token = (generation: number): string => `synthetic-grok-access-token-generation-${generation}-xxxxxxxx`;
const login = (generation: number, expiresAt = "2099-01-01T00:00:00Z"): Buffer => Buffer.from(JSON.stringify({ "https://auth.x.ai::synthetic": { key: token(generation), refresh_token: `synthetic-grok-refresh-${generation}-xx`, expires_at: expiresAt } }));
const generationOf = (value: string): number => Number(/generation-(\d+)/u.exec(value)![1]);

function memoryRealm(initial = login(0)) {
  let stored = initial;
  const realm: PortableRealmAuthority & { staleMarks: number; writes: number } = {
    staleMarks: 0, writes: 0,
    read: async () => Buffer.from(stored),
    replace: async (bytes) => { stored = Buffer.from(bytes); realm.writes += 1; },
    markStale: async () => { realm.staleMarks += 1; },
    assertLive: () => undefined
  };
  return realm;
}

async function rig(t: TestContext, provider: (authorization: string | undefined, response: ServerResponse) => void, refresh: (current: GrokLogin) => Promise<GrokLogin>) {
  const seen: { method: string; url: string; authorization?: string }[] = [];
  const fake = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => { seen.push({ method: request.method ?? "", url: request.url ?? "", authorization: request.headers.authorization }); provider(request.headers.authorization, response); });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const realm = memoryRealm();
  const owner = await createGrokRealmOwner({ authority: realm, refresh, log: () => undefined });
  const keys = parseGatewayKeyTable({ version: GATEWAY_KEY_TABLE_VERSION, keys: {
    [gatewayKeyDigest(GROK_KEY)]: { agent_id: "grok-agent", engines: ["grok"] },
    [gatewayKeyDigest(CODEX_KEY)]: { agent_id: "codex-agent", engines: ["codex"] }
  } });
  const gateway = await startGatewayServer({ keys, grok: { owner, upstreamBaseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1` }, log: () => undefined });
  t.after(async () => { await gateway.close(); await new Promise<void>((resolve) => fake.close(() => resolve())); });
  const call = async (method: string, pathname: string, key = GROK_KEY) => {
    const response = await fetch(`${gateway.url}${pathname}`, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    return { status: response.status, text: `${[...response.headers].join("\n")}\n${await response.text()}` };
  };
  return { call, seen, realm, owner };
}

const ok = (_authorization: string | undefined, response: ServerResponse): void => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("data: [DONE]\n\n"); };
const nextLogin = async (current: GrokLogin): Promise<GrokLogin> => parseGrokAuth(login(generationOf(current.accessToken) + 1));

test("the Grok route list is exactly POST /chat/completions; nothing else is proxied", async (t) => {
  const gateway = await rig(t, ok, nextLogin);
  assert.equal((await gateway.call("POST", "/v1/grok/chat/completions")).status, 200);
  for (const [method, pathname] of [["GET", "/v1/grok/chat/completions"], ["GET", "/v1/grok/models"], ["POST", "/v1/grok/responses"], ["POST", "/v1/grok/chat/completions/x"], ["POST", "/v1/grok//chat/completions"], ["POST", "/v1/grok/chat/completions?x=1"], ["POST", "/v1/grok"], ["POST", "/v1/codex/responses"], ["POST", "/v1/xgrok/chat/completions"]] as const) {
    assert.equal((await gateway.call(method, pathname)).status, 404, `${method} ${pathname}`);
  }
  assert.deepEqual(gateway.seen.map((entry) => `${entry.method} ${entry.url}`), ["POST /v1/chat/completions"]);
});

test("a key buys only its own engines; a bad key is the only 401", async (t) => {
  const gateway = await rig(t, ok, nextLogin);
  const codexKey = await gateway.call("POST", "/v1/grok/chat/completions", CODEX_KEY);
  assert.equal(codexKey.status, 403);
  assert.match(codexKey.text, /engine_not_allowed/u);
  assert.equal((await gateway.call("POST", "/v1/grok/chat/completions", "synthetic-unknown-key-0000")).status, 401);
  assert.equal(gateway.seen.length, 0);
  const health = await gateway.call("GET", "/v1/health");
  assert.equal(health.status, 200, health.text);
  assert.match(health.text, /"realms":\{"grok":"ready"\}/u);
});

test("concurrent upstream 401s share one Grok refresh; every request retries on the new bearer", async (t) => {
  let refreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const gateway = await rig(t, (authorization, response) => {
    if (authorization === `Bearer ${token(0)}`) { response.writeHead(401); response.end(); return; }
    ok(authorization, response);
  }, async (current) => { refreshes += 1; await gate; return nextLogin(current); });
  const pending = Array.from({ length: 8 }, () => gateway.call("POST", "/v1/grok/chat/completions"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((result) => result.status), Array(8).fill(200));
  assert.equal(refreshes, 1);
  assert.equal(gateway.realm.writes, 1);
  assert.ok(gateway.seen.filter((entry) => entry.authorization === `Bearer ${token(1)}`).length === 8);
});

test("a refreshed bearer refused again fences the realm and answers 403 auth_stale, never a relayed 401", async (t) => {
  const gateway = await rig(t, (_authorization, response) => { response.writeHead(401); response.end(); }, nextLogin);
  const first = await gateway.call("POST", "/v1/grok/chat/completions");
  assert.equal(first.status, 403);
  assert.match(first.text, /auth_stale/u);
  assert.equal(gateway.realm.staleMarks, 1);
  assert.equal(gateway.seen.length, 2);
  assert.equal((await gateway.call("POST", "/v1/grok/chat/completions")).status, 403);
  assert.equal(gateway.seen.length, 2, "a fenced realm makes no upstream call");
});

test("only a named CLI refusal fences; a transient refresh failure answers auth_stale without fencing", async (t) => {
  let mode: "transient" | "rejected" = "transient";
  const gateway = await rig(t, (_authorization, response) => { response.writeHead(401); response.end(); }, async () => { throw mode === "rejected" ? new GrokRefreshRejected() : new Error("grok models timed out"); });
  assert.equal((await gateway.call("POST", "/v1/grok/chat/completions")).status, 403);
  assert.equal(gateway.realm.staleMarks, 0);
  assert.equal(gateway.owner.stale(), false);
  mode = "rejected";
  assert.equal((await gateway.call("POST", "/v1/grok/chat/completions")).status, 403);
  assert.equal(gateway.realm.staleMarks, 1);
  assert.equal(gateway.owner.stale(), true);
});

test("proactive refresh before expiry is single-flight and spaced when the CLI leaves the login unchanged", async () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  let clock = now;
  let refreshes = 0;
  const realm = memoryRealm(login(0, "2030-01-01T00:01:00Z"));
  const owner = await createGrokRealmOwner({ authority: realm, now: () => clock, log: () => undefined, refresh: async (current) => { refreshes += 1; return current; } });
  await Promise.all([owner.bearer(), owner.bearer(), owner.bearer()]);
  assert.equal(refreshes, 1);
  assert.equal((await owner.bearer()).generation, 0, "an unchanged login is no new generation");
  assert.equal(realm.writes, 0, "an unchanged login is not written back");
  await owner.bearer();
  assert.equal(refreshes, 1, "an unchanged login is not refreshed on every request");
  clock += 61_000;
  await owner.bearer();
  assert.equal(refreshes, 2);
});

test("the CLI refresh runs in a private scratch home seeded with the login, which is removed afterwards", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-gw-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const command = path.join(root, "grok");
  const next = login(1).toString("utf8").replaceAll("'", "");
  await writeFile(command, `#!/bin/sh\n[ "$1" = models ] || exit 9\ngrep -q generation-0 "$GROK_HOME/auth.json" || exit 8\n[ -f '${root}/fail' ] && { echo "Error: Not signed in" >&2; exit 1; }\nprintf '%s' '${next}' > "$GROK_HOME/auth.json"\n`);
  await chmod(command, 0o700);
  const refreshed = await createGrokRefresh({ command, scratchRoot: scratch })(parseGrokAuth(login(0)));
  assert.equal(refreshed.accessToken, token(1));
  assert.deepEqual(await readdir(scratch), []);
  await writeFile(path.join(root, "fail"), "");
  await assert.rejects(createGrokRefresh({ command, scratchRoot: scratch })(parseGrokAuth(login(0))), GrokRefreshRejected);
  assert.deepEqual(await readdir(scratch), []);
});

test("config accepts a Grok-only gateway and refuses remote Grok upstreams", () => {
  const base = { version: GATEWAY_CONFIG_VERSION, key_table_path: "/etc/daimon-gateway/keys.json" };
  assert.deepEqual(parseGatewayConfig({ ...base, grok: { command: "/usr/local/bin/grok", upstream_base_url: "http://127.0.0.1:9/v1/" } }), { host: "127.0.0.1", port: 0, keyTablePath: "/etc/daimon-gateway/keys.json", grok: { command: "/usr/local/bin/grok", upstreamBaseUrl: "http://127.0.0.1:9/v1" } });
  for (const value of [base, { ...base, grok: { upstream_base_url: "https://cli-chat-proxy.example/v1" } }, { ...base, grok: { command: "grok" } }, { ...base, grok: { token_url: "http://127.0.0.1/x" } }]) assert.throws(() => parseGatewayConfig(value), TypeError);
});

test("a login the CLI rotated before failing is kept; an unchanged one lets the failure stand", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-gw-rotate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const command = path.join(root, "grok");
  await writeFile(command, `#!/bin/sh\n[ -f '${root}/rotate' ] && printf '%s' '${login(1).toString("utf8")}' > "$GROK_HOME/auth.json"\necho "HTTP 429 Too Many Requests" >&2\nexit 1\n`);
  await chmod(command, 0o700);
  await assert.rejects(createGrokRefresh({ command, scratchRoot: scratch })(parseGrokAuth(login(0))), (error: unknown) => error instanceof Error && !(error instanceof GrokRefreshRejected));
  await writeFile(path.join(root, "rotate"), "");
  const kept = await createGrokRefresh({ command, scratchRoot: scratch })(parseGrokAuth(login(0)));
  assert.equal(kept.accessToken, token(1));
  assert.deepEqual(await readdir(scratch), []);
});

test("a forced refresh seeds the scratch login as expired once, and never returns the marked copy", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-gw-expired-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = path.join(root, "scratch");
  await mkdir(scratch, { mode: 0o700 });
  const command = path.join(root, "grok");
  // Like the real CLI: exchange the refresh token only when the login reads as expired.
  await writeFile(command, `#!/bin/sh\ngrep -q generation-0 "$GROK_HOME/auth.json" || exit 8\ngrep -q 1970-01-01 "$GROK_HOME/auth.json" || exit 0\n[ -f '${root}/offline' ] && exit 1\nprintf '%s' '${login(1).toString("utf8")}' > "$GROK_HOME/auth.json"\n`);
  await chmod(command, 0o700);
  const current = parseGrokAuth(login(0));
  assert.equal((await createGrokRefresh({ command, scratchRoot: scratch })(current)).digest, current.digest, "an unexpired login is left alone");
  const forced = createGrokRefresh({ command, scratchRoot: scratch, seedExpiredOnce: true });
  assert.equal((await forced(current)).accessToken, token(1), "the first forced refresh rotates");
  assert.equal((await forced(current)).digest, current.digest, "only the first refresh is seeded expired");
  await writeFile(path.join(root, "offline"), "");
  await assert.rejects(createGrokRefresh({ command, scratchRoot: scratch, seedExpiredOnce: true })(current), "a failed exchange never returns the marked copy");
  await rm(path.join(root, "offline"));
  await writeFile(command, "#!/bin/sh\nexit 0\n");
  assert.equal(await createGrokRefresh({ command, scratchRoot: scratch, seedExpiredOnce: true })(current), current, "a CLI that ignores the mark left the login unchanged");
  assert.deepEqual(await readdir(scratch), []);
});

test("a crashed gateway's scratch homes are swept at start; other entries stay", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-gw-sweep-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "daimon-gateway-refresh-abc123"));
  await writeFile(path.join(root, "daimon-gateway-refresh-abc123", "auth.json"), login(0));
  await mkdir(path.join(root, "other"));
  await sweepGrokRefreshScratch(root);
  assert.deepEqual(await readdir(root), ["other"]);
});
