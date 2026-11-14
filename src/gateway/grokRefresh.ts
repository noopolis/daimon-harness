import { ENGINE_DESCRIPTORS } from "../engines/descriptors.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnRealTime as spawn } from "../runtime/taskClockProcess.js";
import { readChild } from "../pi/cliChildOutput.js";
import { terminateChild, trackCliChild } from "../pi/cliProcess.js";
import { classifyGrokAuthenticationDiagnostic, GrokSubscriptionAuthenticationRejectedError } from "../engines/grok/broker/grokAuthenticationError.js";
import { parseGrokAuth, type GrokLogin } from "./grokCredential.js";

const GROK = ENGINE_DESCRIPTORS.grok;

/** The CLI itself named the login refused (`grokAuthenticationError.ts`): the realm is gone, not the network. */
export class GrokRefreshRejected extends Error {
  constructor() { super("Grok refresh was rejected"); }
}

/**
 * Refreshes the login in `grokHome` the only proven way: the pinned CLI's
 * `models` command, with a positive environment. A diagnostic the CLI names as
 * an authentication refusal throws {@link GrokRefreshRejected}; every other
 * failure (timeout, network, 429) is an ordinary, transient error.
 */
export async function refreshGrokBrokerCredential(command: string, grokHome: string, timeoutMs = 15_000): Promise<void> {
  const child = trackCliChild(spawn(command, ["models"], { detached: process.platform !== "win32", env: { [GROK.homeEnvironment]: grokHome, HOME: grokHome, PATH: process.env.PATH, LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"] }));
  try { await readChild(child, timeoutMs, [], { failureClassifier: classifyGrokAuthenticationDiagnostic }); }
  catch (error) { throw error instanceof GrokSubscriptionAuthenticationRejectedError ? new GrokRefreshRejected() : new Error("Grok broker credential refresh failed"); }
  finally { await terminateChild(child).catch(() => undefined); }
}

export type GrokRefresh = (current: GrokLogin) => Promise<GrokLogin>;
export type GrokRefreshOptions = Readonly<{
  command: string; scratchRoot?: string; timeoutMs?: number; run?: typeof refreshGrokBrokerCredential;
  /** Test-only (`DAIMON_GATEWAY_TEST_FORCE_REFRESH=1`): the first refresh seeds the scratch home with the login marked expired. */
  seedExpiredOnce?: boolean;
}>;

const SCRATCH_PREFIX = "daimon-gateway-refresh-";

/**
 * Gateway refresh: the CLI runs in a private scratch home seeded with the
 * current login, so the realm file changes only through the owner's atomic
 * write-back. The scratch home is removed before this returns.
 *
 * The CLI can rotate the login and still exit non-zero (a 429 on the model
 * listing after a successful token exchange). The old refresh token is then
 * spent, so a rotated login in the scratch home is returned, not discarded;
 * only an unchanged (or unreadable) one lets the failure stand. A login the
 * CLI named as refused is never kept.
 *
 * `grok models` leaves an unexpired login alone, so a forced refresh proves
 * nothing with a fresh one. `seedExpiredOnce` seeds the first scratch copy with
 * `expires_at` in the past: the CLI then exchanges the refresh token for real.
 * The marked copy never leaves the scratch home; a CLI that left it as seeded
 * left the login unchanged.
 */
export function createGrokRefresh(options: GrokRefreshOptions): GrokRefresh {
  const run = options.run ?? refreshGrokBrokerCredential;
  let expire = options.seedExpiredOnce === true;
  return async (current) => {
    const seed = expire ? markExpired(current.bytes) : Buffer.from(current.bytes);
    expire = false;
    const seeded = createHash("sha256").update(seed).digest("hex");
    const unchanged = (left: GrokLogin): boolean => left.digest === current.digest || left.digest === seeded;
    const home = await mkdtemp(path.join(options.scratchRoot ?? os.tmpdir(), SCRATCH_PREFIX));
    try {
      const file = path.join(home, GROK.auth.fileName);
      const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, GROK.auth.fileMode);
      try { await handle.writeFile(seed); } finally { seed.fill(0); await handle.close(); }
      try { await run(options.command, home, options.timeoutMs); }
      catch (error) {
        if (error instanceof GrokRefreshRejected) throw error;
        const left = await readScratchLogin(file).catch(() => undefined);
        if (left !== undefined && !unchanged(left)) return left;
        left?.bytes.fill(0);
        throw error;
      }
      const left = await readScratchLogin(file);
      if (!unchanged(left)) return left;
      left.bytes.fill(0);
      return current;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
}

/** The login's own file with its one row's `expires_at` moved to the epoch. */
function markExpired(bytes: Uint8Array): Buffer {
  const root = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, Record<string, unknown>>;
  for (const row of Object.values(root)) row.expires_at = "1970-01-01T00:00:00Z";
  return Buffer.from(JSON.stringify(root));
}

/** Removes scratch homes a crashed gateway left behind; run once at start, before any refresh. */
export async function sweepGrokRefreshScratch(scratchRoot: string = os.tmpdir()): Promise<void> {
  const entries = await readdir(scratchRoot, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
    .map((entry) => rm(path.join(scratchRoot, entry.name), { recursive: true, force: true })));
}

async function readScratchLogin(file: string): Promise<GrokLogin> {
  const reader = await open(file, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  let bytes: Buffer | undefined;
  try {
    const stat = await reader.stat();
    if (!stat.isFile() || stat.size > GROK.auth.maxCredentialBytes) throw new Error("Grok refresh left no usable login");
    bytes = await reader.readFile();
    return parseGrokAuth(bytes);
  } finally { bytes?.fill(0); await reader.close(); }
}
