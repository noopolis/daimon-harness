import type { PortableRealmAuthority } from "../runtime/portableSubscriptionRealmTypes.js";

/** The realm login cannot buy inference until an operator re-imports it. */
export class RealmAuthStale extends Error {
  constructor() { super("auth_stale"); }
}

/** The realm lease is gone; another process may now hold the login. */
export class RealmLost extends Error {
  constructor() { super("realm_unavailable"); }
}

/** What a relay needs to call upstream: the access token, its generation, and engine extras. */
export type RealmBearer<Extra extends object = object> = Readonly<{ accessToken: string; generation: number }> & Readonly<Extra>;

export type RealmOwner<Extra extends object = object> = Readonly<{
  /** The current bearer, refreshed first when it is about to expire. */
  bearer(): Promise<RealmBearer<Extra>>;
  /** Upstream refused `rejected`: refresh once (shared by every caller) or fail stale. */
  rejected(rejected: RealmBearer<Extra>): Promise<RealmBearer<Extra>>;
  /** A refreshed bearer was still refused: fence the realm instead of refreshing per request. */
  fence(): Promise<void>;
  stale(): boolean;
  /** The realm lease is still held; a lost lease refuses every bearer. */
  live(): boolean;
  /** A refreshed login is not yet durable in the realm; retried until it is. */
  writeBackPending(): boolean;
  /** Exact token values for redaction; never leaves the process. */
  secrets(): readonly string[];
  close(): void;
}>;

/** Engine knowledge a realm owner needs; everything else here is engine-neutral. */
export type RealmLoginCodec<Login, Extra extends object> = Readonly<{
  /** Names the realm in fault lines only. */
  label: string;
  parse(bytes: Uint8Array): Login;
  /** Fresh bytes in the CLI's own schema; the owner zeroes them once durable. */
  render(login: Login, now: Date): Buffer;
  accessToken(login: Login): string;
  extra(login: Login): Extra;
  expiryMs(login: Login): number | undefined;
  secrets(login: Login): readonly string[];
  /** The refresh left the login as it was: no new generation, nothing to write back. */
  same(left: Login, right: Login): boolean;
  /** Only a named refusal of the login fences; anything else stays transient. */
  refreshRejected(error: unknown): boolean;
}>;

export type RealmOwnerOptions<Login> = Readonly<{
  authority: PortableRealmAuthority;
  refresh: (current: Login) => Promise<Login>;
  now?: () => number;
  refreshSkewMs?: number;
  /** Minimum gap between proactive (pre-expiry) refresh attempts; rejection refreshes are never throttled. */
  proactiveRefreshIntervalMs?: number;
  writeBackRetryMs?: number;
  /** Test-only: the first bearer request refreshes the login whatever its expiry (`DAIMON_GATEWAY_TEST_FORCE_REFRESH=1`). */
  forceRefreshOnce?: boolean;
  log?: (line: string) => void;
}>;

const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;
const DEFAULT_WRITE_BACK_RETRY_MS = 5_000;

/** Sole owner of one realm login: single-flight refresh with atomic CLI-schema write-back. */
export async function createRealmOwner<Login, Extra extends object>(
  codec: RealmLoginCodec<Login, Extra>, options: RealmOwnerOptions<Login>
): Promise<RealmOwner<Extra>> {
  const now = options.now ?? Date.now;
  const skew = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const interval = options.proactiveRefreshIntervalMs ?? 0;
  let forced = options.forceRefreshOnce === true;
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const authority = options.authority;
  const bytes = await authority.read();
  let login: Login;
  try { login = codec.parse(bytes); } finally { bytes.fill(0); }
  let generation = 0;
  let stale = false;
  let lastProactive = Number.NEGATIVE_INFINITY;
  let inflight: Promise<RealmBearer<Extra>> | undefined;
  // Bytes of a refreshed login that the realm does not hold yet; the old refresh token on disk is dead.
  let pending: Buffer | undefined;
  let flushing: Promise<void> | undefined;
  let retry: NodeJS.Timeout | undefined;

  const live = (): boolean => { try { authority.assertLive(); return true; } catch { return false; } };
  const assertLive = (): void => { if (!live()) throw new RealmLost(); };
  // Writes are serialized and always carry the newest login, so an older one can never land last.
  const flush = (): Promise<void> => flushing ??= (async () => {
    try {
      await null; // settle the assignment above before `finally` can clear it
      const bytes = pending;
      if (bytes === undefined) return;
      await authority.replace(bytes);
      if (pending === bytes) {
        pending = undefined;
        bytes.fill(0);
        if (retry !== undefined) { clearInterval(retry); retry = undefined; log(`daimon gateway: ${codec.label} realm write-back recovered`); }
      }
    } catch {
      // Still pending: the timer and the next bearer() try again.
    } finally {
      flushing = undefined;
    }
  })();
  const writeBack = async (next: Login): Promise<void> => {
    pending = codec.render(next, new Date(now()));
    await flushing;
    await flush();
    if (pending === undefined || retry !== undefined) return;
    log(`daimon gateway: ${codec.label} realm write-back failed; retrying, readiness refuses until it lands`);
    retry = setInterval(() => { void flush(); }, options.writeBackRetryMs ?? DEFAULT_WRITE_BACK_RETRY_MS);
    retry.unref();
  };
  const fence = async (): Promise<void> => {
    if (stale) return;
    stale = true;
    await authority.markStale().catch(() => log(`daimon gateway: ${codec.label} realm stale fence could not be written`));
    log(`daimon gateway: ${codec.label} realm login was refused; realm is stale`);
  };
  const current = (): RealmBearer<Extra> => ({ ...codec.extra(login), accessToken: codec.accessToken(login), generation });
  const refreshOnce = (): Promise<RealmBearer<Extra>> => inflight ??= (async () => {
    try {
      const next = await Promise.resolve().then(() => options.refresh(login));
      if (codec.same(login, next)) return current();
      login = next;
      generation += 1;
      await writeBack(next);
      return current();
    } catch (error) {
      if (codec.refreshRejected(error)) await fence();
      throw error;
    } finally {
      inflight = undefined;
    }
  })();

  return {
    async bearer() {
      assertLive();
      if (stale) throw new RealmAuthStale();
      if (pending !== undefined) await flush();
      if (inflight !== undefined) return inflight.catch(() => { if (stale) throw new RealmAuthStale(); return current(); });
      const expiry = codec.expiryMs(login);
      if (forced) {
        forced = false;
        const before = generation;
        const bearer = await refreshOnce().catch(() => { if (stale) throw new RealmAuthStale(); return current(); });
        log(`daimon gateway: ${codec.label} forced refresh ${generation > before ? "rotated the login" : "left the login unchanged"}`);
        return bearer;
      }
      if (expiry === undefined || expiry - now() > skew || now() - lastProactive < interval) return current();
      lastProactive = now();
      try { return await refreshOnce(); } catch {
        if (stale) throw new RealmAuthStale();
        return current();
      }
    },
    async rejected(rejected) {
      assertLive();
      if (stale) throw new RealmAuthStale();
      if (rejected.generation < generation) return current();
      try { return await refreshOnce(); } catch { throw new RealmAuthStale(); }
    },
    fence,
    stale: () => stale,
    live,
    writeBackPending: () => pending !== undefined,
    secrets: () => codec.secrets(login).filter((value) => value.length > 0),
    close: () => { clearInterval(retry); retry = undefined; }
  };
}
