import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";
import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";
import { parseCodexAuth, renderCodexAuth, type CodexTokens } from "./codexCredential.js";
import { CodexAuthStale, CodexRealmLost, createCodexRealmOwner } from "./codexRealmOwner.js";
import { CodexRefreshRejected, type CodexRefresh } from "./codexRefresh.js";

const jwt = (claims: Record<string, unknown>): string => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.c2ln`;
const tokens = (generation: number, expSeconds = 4_000_000_000): CodexTokens => ({ idToken: jwt({ sub: "synthetic" }), accessToken: jwt({ exp: expSeconds, g: generation }), refreshToken: `synthetic-refresh-${generation}`, accountId: "acct-synthetic" });

function memoryAuthority(initial: CodexTokens): PortableRealmAuthority & { writes: CodexTokens[]; staleMarks: number } {
  let bytes = renderCodexAuth(initial);
  const authority = {
    writes: [] as CodexTokens[], staleMarks: 0,
    read: async () => Buffer.from(bytes),
    replace: async (next: Uint8Array) => { bytes = Buffer.from(next); authority.writes.push(parseCodexAuth(bytes)); },
    markStale: async () => { authority.staleMarks += 1; },
    assertLive: () => undefined
  };
  return authority;
}

test("concurrent rejections share exactly one refresh", async () => {
  const authority = memoryAuthority(tokens(0));
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const refresh: CodexRefresh = async (current) => { calls += 1; await gate; return { ...tokens(Number(current.refreshToken.split("-").at(-1)) + 1) }; };
  const owner = await createCodexRealmOwner({ authority, refresh, log: () => undefined });
  const first = await owner.bearer();
  const pending = Array.from({ length: 12 }, () => owner.rejected(first));
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  assert.equal(new Set(results.map((bearer) => bearer.accessToken)).size, 1);
  assert.equal(results[0]!.generation, 1);
  assert.equal(authority.writes.length, 1);
  assert.equal(authority.writes[0]!.refreshToken, "synthetic-refresh-1");
  // A late rejection of the old generation reuses the refreshed bearer.
  assert.equal((await owner.rejected(first)).generation, 1);
  assert.equal(calls, 1);
});

test("refreshes before expiry from the exp claim", async () => {
  const now = 1_000_000_000_000;
  const authority = memoryAuthority(tokens(0, now / 1000 + 60));
  let calls = 0;
  const owner = await createCodexRealmOwner({ authority, now: () => now, log: () => undefined, refresh: async () => { calls += 1; return tokens(1, now / 1000 + 3600); } });
  const [left, right] = await Promise.all([owner.bearer(), owner.bearer()]);
  assert.equal(calls, 1);
  assert.equal(left.generation, 1);
  assert.equal(right.accessToken, left.accessToken);
  assert.equal((await owner.bearer()).generation, 1);
  assert.equal(calls, 1);
});

test("a rejected refresh fences the realm; a transient one does not", async () => {
  const authority = memoryAuthority(tokens(0));
  let mode: "transient" | "rejected" = "transient";
  const owner = await createCodexRealmOwner({ authority, log: () => undefined, refresh: async () => { throw mode === "rejected" ? new CodexRefreshRejected() : new Error("network"); } });
  const bearer = await owner.bearer();
  await assert.rejects(owner.rejected(bearer), CodexAuthStale);
  assert.equal(owner.stale(), false);
  assert.equal(authority.staleMarks, 0);
  mode = "rejected";
  await assert.rejects(owner.rejected(bearer), CodexAuthStale);
  assert.equal(owner.stale(), true);
  assert.equal(authority.staleMarks, 1);
  await assert.rejects(owner.bearer(), CodexAuthStale);
});

test("a pending write-back is retried on a timer", async () => {
  const authority = memoryAuthority(tokens(0));
  const replace = authority.replace;
  let failures = 2;
  (authority as { replace: typeof replace }).replace = async (bytes) => { if (failures > 0) { failures -= 1; throw new Error("disk"); } await replace(bytes); };
  const owner = await createCodexRealmOwner({ authority, log: () => undefined, writeBackRetryMs: 10, refresh: async () => tokens(1) });
  await owner.rejected(await owner.bearer());
  assert.equal(owner.writeBackPending(), true);
  for (let attempt = 0; owner.writeBackPending() && attempt < 100; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(owner.writeBackPending(), false);
  assert.equal(authority.writes.at(-1)!.refreshToken, "synthetic-refresh-1");
  owner.close();
});

test("a lost lease refuses the bearer", async () => {
  const authority = memoryAuthority(tokens(0));
  const owner = await createCodexRealmOwner({ authority, log: () => undefined, refresh: async () => tokens(1) });
  assert.equal(owner.live(), true);
  (authority as { assertLive: () => void }).assertLive = () => { throw new Error("lease gone"); };
  assert.equal(owner.live(), false);
  await assert.rejects(owner.bearer(), CodexRealmLost);
});

test("owns the real portable realm: reads it, writes back the CLI schema, and fences it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-gateway-realm-"));
  try {
    const durablePath = path.join(root, "realm");
    const bootstrapPath = path.join(root, "bootstrap-auth");
    const fakeFlock = path.join(root, "fake-flock.mjs");
    await mkdir(durablePath, { mode: 0o700 });
    await writeFile(bootstrapPath, renderCodexAuth(tokens(0)), { mode: 0o600 });
    await writeFile(fakeFlock, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    await chmod(fakeFlock, 0o700);
    const options = { durablePath, bootstrapPath, flock: fakeFlock };
    let realm = await startCodexSubscriptionRealm(options);
    const owner = await createCodexRealmOwner({ authority: realm.authority, log: () => undefined, refresh: async () => tokens(1) });
    await owner.rejected(await owner.bearer());
    assert.equal(parseCodexAuth(await readFile(path.join(durablePath, "auth.json"))).refreshToken, "synthetic-refresh-1");
    await realm.close();
    realm = await startCodexSubscriptionRealm(options);
    const restarted = await createCodexRealmOwner({ authority: realm.authority, log: () => undefined, refresh: async () => { throw new CodexRefreshRejected(); } });
    assert.equal((await restarted.bearer()).accessToken, tokens(1).accessToken);
    await restarted.fence();
    await assert.rejects(realm.authority.read(), /unavailable or stale/u);
    await realm.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a forced refresh rotates a fresh login once, shared by concurrent first requests", async () => {
  const authority = memoryAuthority(tokens(0));
  let calls = 0;
  const lines: string[] = [];
  const refresh: CodexRefresh = async () => { calls += 1; return tokens(1); };
  const owner = await createCodexRealmOwner({ authority, refresh, forceRefreshOnce: true, log: (line) => lines.push(line) });
  const [left, right] = await Promise.all([owner.bearer(), owner.bearer()]);
  assert.deepEqual([left.generation, right.generation, calls], [1, 1, 1]);
  assert.equal(authority.writes[0]!.refreshToken, "synthetic-refresh-1");
  assert.equal((await owner.bearer()).generation, 1);
  assert.equal(calls, 1);
  assert.deepEqual(lines, ["daimon gateway: codex forced refresh rotated the login"]);
  // Without the flag, an unexpired login never refreshes.
  const unforced = await createCodexRealmOwner({ authority: memoryAuthority(tokens(0)), refresh, log: () => undefined });
  assert.equal((await unforced.bearer()).generation, 0);
  assert.equal(calls, 1);
});
