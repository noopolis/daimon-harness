# Daimon auth gateway

`daimon-runtime gateway --config <path>` is the sole holder of a subscription
login. Agents get `DAIMON_GATEWAY_URL` and a per-agent `DAIMON_GATEWAY_KEY`;
the gateway swaps that key for the realm bearer upstream. Design:
`AUTH_GATEWAY_DESIGN.md` in the ecosystem folder. It serves Codex and Grok; AGY
is never gatewayed.

Rules:

- Status contract: 401 only for a bad agent key. An upstream 401 refreshes once
  (single-flight across every request) and retries. A refresh the token
  endpoint rejects, or a second 401, fences the realm (durable stale file);
  a transient refresh failure answers the same 403 `auth_stale` without
  fencing. Never a relayed 401 and never 5xx. Upstream 429 and 5xx are relayed with a bounded, redacted body.
- Fixed upstreams and a closed route list per engine (`CODEX_GATEWAY_ROUTES`,
  `GROK_GATEWAY_ROUTES`); anything else is 404. A config may override an upstream only to a loopback URL.
- Never log a header, body, key or token. Fault lines name an error class only.
- The key table stores `sha256(key)` only and is compared in constant time.
- The realm is the existing portable realm (`../runtime/portableSubscriptionRealm.ts`):
  the gateway holds its exclusive flock for life through `authority`, and every
  write-back is the CLI's own `auth.json` schema (`codexCredential.ts`; the
  Grok file is written back byte for byte).
- `realmOwner.ts`, `server.ts`, `relay.ts` and `route.ts` are engine-neutral.
  Engine knowledge (upstream, routes, bearer headers, refresh, credential
  schema) lives in `codex*.ts` and `grok*.ts` only.
- Keep the key's env name ending in `_KEY`: Codex's shell policy excludes
  `*KEY*` names from model-run commands.

Use named exports, keep files under 400 lines, tests beside files.

`DAIMON_GATEWAY_TEST_FORCE_REFRESH=1` is a test-only hook: each realm owner
refreshes its login on its first bearer request whatever the expiry, once, and
logs `daimon gateway: <engine> forced refresh rotated the login` (or `left the
login unchanged`). It exists so a pilot can prove a mid-run rotation through the
gateway without anyone touching a login file. Production never sets it.
`grok models` leaves an unexpired login alone, so the Grok refresh seeds that
one forced attempt's scratch home with `expires_at` in the past
(`seedExpiredOnce`, `grokRefresh.ts`); the realm file is never marked.
