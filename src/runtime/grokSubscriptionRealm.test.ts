import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { startGrokSubscriptionRealm } from "./grokSubscriptionRealm.js";
import { GrokSubscriptionAuthenticationRejectedError } from "./grokAuthenticationError.js";
import type { OrganizationRuntimeAgentConfig } from "./organizationRuntime.js";

type GrokAgent = OrganizationRuntimeAgentConfig & { engine: { kind: "grok" } };
const credential = (generation: string): string => JSON.stringify({
  "https://auth.x.ai::account": {
    expires_at: "2099-01-01T00:00:00.000Z",
    key: `access-${generation}`,
    refresh_token: `refresh-${generation}`
  }
});
const agent = (root: string, id: string): GrokAgent => ({
  engine: { kind: "grok" }, id, instructions: "Work.", name: id,
  runtimeHomePath: path.join(root, "homes", id), workspacePath: path.join(root, "workspaces", id)
});

test("serializes Grok turns, promotes rotation, and preserves the realm across restart", async (t) => {
  const previousEnvironment = process.env;
  process.env = { ...previousEnvironment, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }), LD_PRELOAD: "/missing/libfaketime.so.1", FAKETIME: "stale" };
  t.after(() => { process.env = previousEnvironment; });
  const fixture = await createFixture();
  const first = agent(fixture.root, "first");
  const second = agent(fixture.root, "second");
  await prepareAgents([first, second]);
  let realm = await startGrokSubscriptionRealm([first, second], fixture.options);
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  try {
    const firstTurn = realm.withCredential(first, async () => {
      events.push("first-start");
      assert.equal(await readFile(authPath(first), "utf8"), credential("bootstrap"));
      await blocked;
      await writePrivate(authPath(first), credential("rotated-one"));
      events.push("first-end");
    });
    const secondTurn = realm.withCredential(second, async () => {
      events.push("second-start");
      assert.equal(await readFile(authPath(second), "utf8"), credential("rotated-one"));
      await writePrivate(authPath(second), credential("rotated-two"));
      events.push("second-end");
    });
    for (let attempt = 0; events.length === 0 && attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try { assert.deepEqual(events, ["first-start"]); } finally { release(); }
    await Promise.all([firstTurn, secondTurn]);
    assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
    await assert.rejects(readFile(authPath(first)), { code: "ENOENT" });
    await assert.rejects(readFile(authPath(second)), { code: "ENOENT" });
    await realm.close();

    realm = await startGrokSubscriptionRealm([first, second], fixture.options);
    await realm.withCredential(first, async () => {
      assert.equal(await readFile(authPath(first), "utf8"), credential("rotated-two"));
    });
  } finally {
    await realm.close().catch(() => undefined);
    await fixture.close();
  }
});

test("fails stale after credential deletion and accepts only a fresh operator bootstrap", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "reporter");
  await prepareAgents([configured]);
  let realm = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await assert.rejects(realm.withCredential(configured, async () => {
      await rm(authPath(configured));
      throw new Error("RefreshTokenRejected secret-canary");
    }), (error: Error) => {
      assert.equal(error.message, "Grok subscription credential realm is unavailable or stale");
      assert.doesNotMatch(error.message, /secret-canary|RefreshTokenRejected|reporter/u);
      return true;
    });
    await assert.rejects(realm.withCredential(configured, async () => undefined), /unavailable or stale/);
    await realm.close();

    await writePrivate(fixture.bootstrapPath, credential("operator-renewed"));
    const future = new Date(Date.now() + 2_000);
    await utimes(fixture.bootstrapPath, future, future);
    realm = await startGrokSubscriptionRealm([configured], fixture.options);
    await realm.withCredential(configured, async () => {
      assert.equal(await readFile(authPath(configured), "utf8"), credential("operator-renewed"));
    });
  } finally {
    await realm.close().catch(() => undefined);
    await fixture.close();
  }
});

test("never reimports an unchanged revoked bootstrap when durable authority is absent", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "revoked-bootstrap");
  await prepareAgents([configured]);
  const realm = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await assert.rejects(realm.withCredential(configured, async () => {
      throw new GrokSubscriptionAuthenticationRejectedError();
    }), /unavailable or stale/u);
    await realm.close();
    await rm(path.join(fixture.durablePath, "auth.json"));
    await assert.rejects(startGrokSubscriptionRealm([configured], fixture.options), /unavailable or stale/u);
    await assert.rejects(readFile(path.join(fixture.durablePath, "auth.json")), { code: "ENOENT" });
  } finally { await realm.close().catch(() => undefined); await fixture.close(); }
});

test("stale-fences a typed provider auth rejection even when Grok leaves valid stale bytes", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "reviewer");
  await prepareAgents([configured]);
  const realm = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await assert.rejects(realm.withCredential(configured, async () => {
      await writePrivate(authPath(configured), credential("still-structurally-valid"));
      throw new GrokSubscriptionAuthenticationRejectedError();
    }), (error: Error) => {
      assert.equal(error.message, "Grok subscription credential realm is unavailable or stale");
      assert.doesNotMatch(error.message, /reviewer|structurally|rejected/u);
      return true;
    });
    await assert.rejects(realm.withCredential(configured, async () => undefined), /unavailable or stale/u);
  } finally { await realm.close(); await fixture.close(); }
});

test("recovers the journaled rotated credential after a host crash", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "editor");
  await prepareAgents([configured]);
  const sourceDigest = createHash("sha256").update(credential("before-crash")).digest("hex");
  await writePrivate(path.join(fixture.durablePath, "auth.json"), credential("before-crash"));
  await writePrivate(authPath(configured), credential("after-crash"));
  await writePrivate(path.join(fixture.durablePath, "lease.json"), `${JSON.stringify({
    agent_id: configured.id, source_digest: sourceDigest, state: "active",
    version: "noopolis.daimon.grok-credential-lease.v1"
  })}\n`);
  const realm = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await realm.withCredential(configured, async () => {
      assert.equal(await readFile(authPath(configured), "utf8"), credential("after-crash"));
    });
  } finally {
    await realm.close(); await fixture.close();
  }
});

test("stale-fences a crash journal whose source authority changed", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "source-drift");
  await prepareAgents([configured]);
  await writePrivate(path.join(fixture.durablePath, "auth.json"), credential("unexpected-source"));
  await writePrivate(authPath(configured), credential("candidate"));
  await writePrivate(path.join(fixture.durablePath, "lease.json"), `${JSON.stringify({
    agent_id: configured.id,
    source_digest: createHash("sha256").update(credential("expected-source")).digest("hex"),
    state: "active",
    version: "noopolis.daimon.grok-credential-lease.v1"
  })}\n`);
  try {
    await assert.rejects(startGrokSubscriptionRealm([configured], fixture.options), /unavailable or stale/u);
    await assert.rejects(readFile(authPath(configured)), { code: "ENOENT" });
  } finally { await fixture.close(); }
});

test("recovers every post-promotion crash cut without falsely staling the realm", async () => {
  for (const stagedCopyPresent of [true, false]) {
    const fixture = await createFixture();
    const configured = agent(fixture.root, stagedCopyPresent ? "promoted-copy" : "promoted-cleaned");
    await prepareAgents([configured]);
    const promoted = credential(`promoted-${stagedCopyPresent}`);
    const promotedDigest = createHash("sha256").update(promoted).digest("hex");
    await writePrivate(path.join(fixture.durablePath, "auth.json"), promoted);
    if (stagedCopyPresent) await writePrivate(authPath(configured), promoted);
    await writePrivate(path.join(fixture.durablePath, "lease.json"), `${JSON.stringify({
      agent_id: configured.id, promoted_digest: promotedDigest, source_digest: "1".repeat(64), state: "promoted",
      version: "noopolis.daimon.grok-credential-lease.v1"
    })}\n`);
    const realm = await startGrokSubscriptionRealm([configured], fixture.options);
    try {
      await realm.withCredential(configured, async () => {
        assert.equal(await readFile(authPath(configured), "utf8"), promoted);
      });
      await assert.rejects(readFile(path.join(fixture.durablePath, "lease.json")), { code: "ENOENT" });
    } finally { await realm.close(); await fixture.close(); }
  }
});

test("recovers both sides of the authoritative promotion rename", async () => {
  for (const authorityPromoted of [false, true]) {
    const fixture = await createFixture();
    const configured = agent(fixture.root, `promoting-${authorityPromoted}`);
    await prepareAgents([configured]);
    const source = credential("source-before-promotion");
    const promoted = credential(`promotion-${authorityPromoted}`);
    const sourceDigest = createHash("sha256").update(source).digest("hex");
    const promotedDigest = createHash("sha256").update(promoted).digest("hex");
    await writePrivate(path.join(fixture.durablePath, "auth.json"), authorityPromoted ? promoted : source);
    await writePrivate(authPath(configured), promoted);
    await writePrivate(path.join(fixture.durablePath, "lease.json"), `${JSON.stringify({
      agent_id: configured.id, promoted_digest: promotedDigest, source_digest: sourceDigest, state: "promoting",
      version: "noopolis.daimon.grok-credential-lease.v1"
    })}\n`);
    const realm = await startGrokSubscriptionRealm([configured], fixture.options);
    try {
      await realm.withCredential(configured, async () => {
        assert.equal(await readFile(authPath(configured), "utf8"), promoted);
      });
      await assert.rejects(readFile(path.join(fixture.durablePath, "lease.json")), { code: "ENOENT" });
    } finally { await realm.close(); await fixture.close(); }
  }
});

test("recovers injected crashes at both authoritative promotion fault points", async () => {
  for (const faultPoint of ["promotion_prepared", "authority_replaced"] as const) {
    const fixture = await createFixture();
    const configured = agent(fixture.root, `fault-${faultPoint}`);
    await prepareAgents([configured]);
    let fired = false;
    let realm = await startGrokSubscriptionRealm([configured], {
      ...fixture.options,
      onTransitionForTest: (stage) => {
        if (!fired && stage === faultPoint) { fired = true; throw new Error("injected crash"); }
      }
    });
    try {
      await assert.rejects(realm.withCredential(configured, async () => {
        await writePrivate(authPath(configured), credential(`rotated-${faultPoint}`));
      }), /injected crash/u);
      assert.equal(fired, true);
      await realm.close();
      realm = await startGrokSubscriptionRealm([configured], fixture.options);
      await realm.withCredential(configured, async () => {
        assert.equal(await readFile(authPath(configured), "utf8"), credential(`rotated-${faultPoint}`));
      });
    } finally { await realm.close().catch(() => undefined); await fixture.close(); }
  }
});

test("imports an explicitly replaced bootstrap without relying on timestamps", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "publisher");
  await prepareAgents([configured]);
  let realm = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await realm.withCredential(configured, async () => {
      await writePrivate(authPath(configured), credential("runtime-rotation"));
    });
    await realm.close();
    await writePrivate(fixture.bootstrapPath, credential("operator-replacement"));
    const past = new Date(Date.now() - 86_400_000);
    await utimes(fixture.bootstrapPath, past, past);
    realm = await startGrokSubscriptionRealm([configured], fixture.options);
    await realm.withCredential(configured, async () => {
      assert.equal(await readFile(authPath(configured), "utf8"), credential("operator-replacement"));
    });
  } finally {
    await realm.close().catch(() => undefined);
    await fixture.close();
  }
});

test("rejects replaced control metadata without reflecting its contents", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "copydesk");
  await prepareAgents([configured]);
  const realm = await startGrokSubscriptionRealm([configured], fixture.options);
  await realm.close();
  const outside = path.join(fixture.root, "outside-control");
  await writePrivate(outside, "secret-control-canary");
  await rm(path.join(fixture.durablePath, "bootstrap.json"));
  await symlink(outside, path.join(fixture.durablePath, "bootstrap.json"));
  try {
    await assert.rejects(startGrokSubscriptionRealm([configured], fixture.options), (error: Error) => {
      assert.equal(error.message, "Grok subscription credential realm is unavailable or stale");
      assert.doesNotMatch(error.message, /secret-control-canary|outside-control|copydesk/u);
      return true;
    });
  } finally {
    await fixture.close();
  }
});

test("fails closed instead of repairing linked durable authority", async () => {
  const fixture = await createFixture();
  const configured = agent(fixture.root, "legal");
  await prepareAgents([configured]);
  const realm = await startGrokSubscriptionRealm([configured], fixture.options);
  await realm.close();
  await link(
    path.join(fixture.durablePath, "auth.json"),
    path.join(fixture.root, "linked-authority-canary")
  );
  try {
    await assert.rejects(startGrokSubscriptionRealm([configured], fixture.options), (error: Error) => {
      assert.equal(error.message, "Grok subscription credential realm is unavailable or stale");
      assert.doesNotMatch(error.message, /linked-authority-canary|legal/u);
      return true;
    });
  } finally {
    await fixture.close();
  }
});

test("holds one process-wide Grok realm lease", { skip: process.platform !== "linux" }, async () => {
  const fixture = await createFixture({ realFlock: true });
  const configured = agent(fixture.root, "wire");
  await prepareAgents([configured]);
  const first = await startGrokSubscriptionRealm([configured], fixture.options);
  try {
    await assert.rejects(
      startGrokSubscriptionRealm([configured], fixture.options),
      /unavailable or stale/u
    );
    await first.close();
    const replacement = await startGrokSubscriptionRealm([configured], fixture.options);
    await replacement.close();
  } finally {
    await first.close().catch(() => undefined);
    await fixture.close();
  }
});

async function createFixture(settings: { realFlock?: boolean } = {}): Promise<{
  bootstrapPath: string;
  close(): Promise<void>;
  durablePath: string;
  options: Parameters<typeof startGrokSubscriptionRealm>[1];
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-realm-"));
  const durablePath = path.join(root, "realm");
  const bootstrapPath = path.join(root, "bootstrap-auth");
  const fakeFlock = path.join(root, "fake-flock.mjs");
  await mkdir(durablePath, { mode: 0o700 });
  await writePrivate(bootstrapPath, credential("bootstrap"));
  await writeFile(fakeFlock, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
  await chmod(fakeFlock, 0o700);
  return {
    bootstrapPath, durablePath, root,
    close: () => rm(root, { recursive: true, force: true }),
    options: {
      bootstrapPath,
      durablePath,
      ...(settings.realFlock ? {} : { flock: fakeFlock })
    }
  };
}

async function prepareAgents(agents: readonly GrokAgent[]): Promise<void> {
  await Promise.all(agents.flatMap((configured) => [
    mkdir(path.dirname(authPath(configured)), { recursive: true, mode: 0o700 }),
    mkdir(configured.workspacePath, { recursive: true, mode: 0o700 })
  ]));
}
function authPath(configured: GrokAgent): string { return path.join(configured.runtimeHomePath, ".grok", "auth.json"); }
async function writePrivate(file: string, value: string): Promise<void> { await writeFile(file, value, { mode: 0o600 }); await chmod(file, 0o600); }
