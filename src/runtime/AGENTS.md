# Daimon organization-runtime contract

This folder owns the versioned, organization-neutral contract and host for
isolated Daimon agents and their runtime-native durable schedules. It is not a
compiler, organization graph, Moltnet adapter, or deployment surface.

Keep config parsing pure and strict. The config must never contain credentials,
commands, argument arrays, arbitrary environment maps, process handles, or
caller-selected implementation hooks. The host may route only explicit
agent-id wakes and lifecycle operations; it cannot select, generate, or
coordinate wakes.

Every source file stays below 400 lines. Keep tests beside the contract they
cover.

`grokBrokerProxyRequest.ts` preserves the worker CLI's `x-grok-client-version`
and supplies its `grok-shell` client identity when rebuilding provider headers.
Dropping the version makes the subscription provider reject an otherwise valid
login with HTTP 426; never replace it with a fabricated version or pass
arbitrary worker headers through. The version must equal the pinned
`GROK_ENGINE_BROKER.grokCliVersion` (1.0.34) exactly.

The proxy is also the spend gate for the lean Grok worker. Before a bearer is
attached it refuses any body whose tool names are not exactly
`GROK_WORKER_VISIBLE_TOOLS` (Grok 1.0.34 turns an unmappable `--tools` entry
into its full 19-tool set, and its `session_title` request carries one forced
tool), and any body whose `model`/`reasoning_effort` differ from the declared
`grokBrokerModelPolicy.ts` policy (closed lists; default `grok-4.6`/`low`). The
model override header follows that declaration.

The proxy is the per-turn limit gate too. Every broker turn registers a
`grokBrokerTurnMeter.ts` meter with its registration's model policy, and the
proxy forwards nothing for a turn without one. After a body is proven a lean
worker request and before any upstream call, the meter refuses request
`maxRequests + 1`, any request past `timeoutMs`, and any request once the
upstream-reported running total has reached `maxTokens` — fresh prompt tokens
and completion in full, cached prompt reads at their billed weight
(`GROK_CACHED_INPUT_TOKEN_WEIGHT`, 0.25; `grokCeilingTokens`). Counting cached
reads in full made the ceiling a context-size limit: writing and composing turns
re-read their conversation every request, 85–90% from cache, and died at a
1.1M "ceiling" having spent about a third of it. Sealed usage and every ledger
keep cached tokens at their raw count. HTTP 429, and the tripped limit aborts
the worker through the ordinary cancel/kill path. The token ceiling is checked
between requests, so a turn overshoots it by at most the last admitted
request. That bound holds only because a turn has at most one upstream request
in flight: an overlapping request is refused (429, uncounted), and Grok's loop
is sequential in every live capture. A per-request usage block above
`turnLimits.requestUsageMaxTokens` (500k) is invalid, and a response without
valid usage is charged `ceil(bodyBytes/2) + 4096` tokens (rows say
`usage_source: "estimated"`, usage rows `estimated_requests`), so a missing
`usage` never disables the ceiling. A broker timer also trips `timeout` for a
worker that is mid-request, and any trip aborts the in-flight upstream call. Limits come from `service.json` v2
(`engineBrokerServiceConfig.ts`; v1 gets `GROK_ENGINE_BROKER.turnLimits.v1Defaults`)
and a wake may only lower them: a raise is refused as `invalid_request`, never
clamped.

The broker stays the single sealed usage writer. `grokEngineBrokerTurn.ts`
seals every terminal turn — completed, failed, limit, cancelled — through
`finishBrokerTurnWithUsage` (`grokEngineBrokerMetering.ts`): the turn registry
record v2 stores the control-protocol v2 terminal response *with* its
numeric-only accounting (`usage`, `outcome`, declared `model`, `requests`,
closed `limitReason`) *and the exact ledger bytes it owes*, and only then are
those bytes appended. A replay returns the sealed accounting and never meters
again; it only appends the sealed bytes when the ledger has no row for that
`turn` (a crash between seal and append). Two replays of one sealed turn in
the same broker may both append those identical bytes (a second broker cannot
exist: the realm lease is an exclusive lock), so **every ledger consumer —
`wakeFuse.ts`, Spawnfile's reader (P3), Paideia's evidence reader (P4) — MUST
dedupe usage rows by `turn`** (`dedupeTurnUsageRows`). The turn record's rename
is its publish point: a directory-sync failure after it is reported, never
raised, so a published completed turn is never re-sealed as failed. The window not closed: a crash
before the record's rename seals the turn `failed` with `usage: null` on the
next boot. Once a completed record is sealed, nothing after it can re-seal the
turn as failed. v1 records still replay (upgraded with `usage: null`). Completed usage is the terminal `result.usage`;
a failed turn's partial usage is its per-request stream frames
(`../pi/grokStreamUsage.ts`) when output arrived, else the upstream usage the
proxy saw. Usage rows carry `turn` (the idempotency key readers dedupe on —
`wakeFuse.ts` does), `limit_reason` and `model`; per-request rows go to
`requests.jsonl` beside the registration's `usageLedgerPath` with proxy-measured
`started_at`/`ended_at`. A provider-reported model key must map to the declared
model (`grok-4.6-build` → `grok-4.6`), otherwise the turn fails as rejected and
is still metered. Control protocol v2 is refused-v1 on the wire because both
ends ship in this package.

A failed brokered turn also carries the worker's own last words. The launcher
gives the worker one pipe for stdout and stderr and publishes no output for a
failure, so a `worker_failed` turn used to reach the host as nothing but
`exit=1` — the reason the worker printed died with the container's tmpfs.
`DBL_MAX_DIAGNOSTIC` (512 bytes) is now the launcher's bounded tail of that
pipe, sent beside the fixed result frame in `diagnostic_length` and kept only
for a worker that exited on its own account: an output-limit tail would be the
very payload the bound refused, a cancelled turn has no reader left, and a
prelaunch failure ran nothing. `engineBrokerNativeClient.ts` redacts that tail
exactly as the CLI child path redacts a failed engine child
(`redactCredentialText` with the turn's own provider/MCP capabilities as exact
secrets, the same `CLI_ENGINE_MAX_DIAGNOSTIC_BYTES` bound) and flattens it to
one line as `diagnostic.reason`.

Two rules that live capture taught, both cheap and both load bearing. The
bytes are **decoded**, never stringified: `Uint8Array.prototype.toString("utf8")`
ignores its argument and renders bytes as comma-separated decimals, and a
worker's last words reached an operator as
`reason=108,111,110,101,46,32,87,104,101,110,...` — a string, control-character
free, inside the bound, and passing every check on the way out. So the frame is
normalized to a `Buffer` once on entry and the diagnostic goes through an
explicit `TextDecoder`, which also replaces rather than throws on the
multi-byte sequence a byte-counted window can cut in half. And the window
keeps **both ends** (`boundedDiagnosticWindow`): a worker that dies early
prints its error before it echoes its input, so a pure tail is the echo. The
marker is paid out of the same budget, and output that fits is returned
byte-identical. The launcher's own 512-byte window keeps both ends too
(`diagnostic_window`, `native/AGENTS.md`), so the head of a large blob now
survives the one place it used to be erased. Its elision is a cut, and a cut
can split a capability in half into a fragment exact redaction cannot match, so
`scrubCutFragments` matches that fragment here, where the turn's capabilities
are known — on both sides of every marker and at the window's outer ends. A
margin reserved in the launcher could not do this: there, what is kept is
exactly what is sent. It is an optional, control-character-free
member of the sealed terminal response's closed diagnostic — admitted by
`engineBrokerProtocol.ts` only for the statuses where a worker ran and spoke —
so it replays with the sealed record and reaches the operator through
`engineBrokerControlClient.ts`'s failure message. Nothing new is written to
disk: the reason travels inside the response the broker already seals.

A turn whose worker said nothing still records what it spent. The launcher can
refuse to publish a worker's output (`DBL_MAX_OUTPUT`, `native/AGENTS.md`) and
the native transport can fail outright, and in both cases `result.text` never
exists, so there are no stream frames to read usage from. `streamOrMeterUsage`
then falls to the proxy's own per-request measurements — the meter admitted and
settled every forwarded request, so the broker knows the spend even when the
worker never speaks — and `finishBrokerTurnWithUsage` seals and appends it with
`outcome: "failed"`. That is the whole of the guarantee and it is pinned by
"a worker whose work succeeded but whose output crossed the launcher bound"
(`grokEngineBrokerUsage.test.ts`), which builds the launcher's own
output-limit frame at the ABI offsets and decodes it with the shipped client.
Deleting the meter fallback, or refusing that frame shape in
`decodeNativeBrokerResult`, both turn it red. The one window that stays open is
the documented one: a crash before the turn record's rename, which the next
boot seals `usage: null`.

**A brokered turn ends when its model has answered, not when its worker
exits** (`grokEngineBrokerTurnEnd.ts`). Grok 1.0.34 regularly logs
`handle_prompt.done ok:true`, ends its session `turn_ended completed`, and then
does not exit; 61 of 128 production turns over two days sat 8–27 minutes after
their last model request until the wall clock killed them and were sealed
`failed/timeout` with their work done. The launcher publishes stdout only on
exit, so the broker decides instead, from what the proxy already sees: a
successful response that called no tool and stopped is the final reply
(`parseGrokFinalReply`, recorded by the meter only while it is the latest
request; a new request forgets it). After `finalGraceMs` (15 s) with no model
request and no MCP tool call in flight, the broker aborts the native run — the
ordinary cancel/kill path — and seals the turn **completed** with that reply,
the proxy-metered usage, and the worker it observed in `/proc` while it was
alive (`findGrokWorkerProcess`: the identity's newest process whose parent it
does not own — a previous turn's hung worker may still be beside it). The same completed seal covers finished work the launcher's output
bound refused (`output_limit` publishes nothing; the frame's own worker pid is
used) and a final reply that idled into the deadline; never a token or request
limit, a caller cancellation, a rejected or unattested stdout, a failed
isolation attestation, or a model request or MCP tool call still in flight. Only
`finish_reason: "stop"` is final — `length` was cut off and `content_filter`
withheld. The worker is read from `/proc` on the first watchdog poll after its first
request, long before anything can end the turn; what was in flight is read
synchronously at the instant the turn is aborted (live, when nothing was
aborted), before killing the worker can close its calls. A turn the broker aborted is sealed only
after its worker identity — zombies included — has stayed empty for 300 ms
(polled from `/proc`, bounded at `GROK_WORKER_REAP_WAIT_MS`, 10 s), so the
agent's next worker is never started where the previous launcher handler's
identity-wide reap would kill it. The reply is
bounded at `GROK_FINAL_REPLY_MAX_BYTES` (64 KiB) with a marker naming what was
cut. A worker with no model request, no tool call in flight and no activity of
either for `idleMs` (10 min) trips the meter's `timeout` and seals as one —
the backstop for a stall that never answers; Grok's own shell tools are
invisible to the broker, hence minutes. The open MCP GET tunnel every hung turn
showed is a symptom: against the real binary, Grok exits ~55 ms after `result`
with the tunnel open, closed, refused or absent, and reopens a closed tunnel
within milliseconds, so closing it is not a way to end a worker.

Evaluator inference grants (`grokInferenceGrants.ts`) let Paideia judges and
the DSPy optimizer — uid 2000, the trusted evaluator side — spend the broker's
Grok credential without holding it. `request_inference_grant {model,
reasoningEffort, purpose: judge|optimizer}` is an additive control protocol v2
verb (`engineBrokerInferenceProtocol.ts`); only the organization uid reaches it,
because the native relay admits only that `SO_PEERCRED` uid on `control.sock`
(the TS backend sees only the relay). The answer is a token
(`inference_` + 32 random bytes), the proxy base URL, an expiry (TTL ten
minutes) and the manifest limits; `release_inference_grant` frees one of the
eight live-grant slots early. Grants are their own kind: their own map keyed by
a random grant id, never the turn capability or turn meter maps, and the proxy
routes a bearer by its prefix to exactly one of the two lookups. A grant has no
worker isolation guard but the same spend gate as a turn (one request in
flight, request ceiling, between-requests token ceiling, estimate on missing
usage), so one grant is one sequential lane — parallel judges each hold one.
`grokInferenceProxyRequest.ts` accepts exactly what Grok 1.0.34 sends for the
Paideia judge argv (live stub capture): `stream: true` with
`stream_options.include_usage`, the declared `model`/`reasoning_effort`, plain
`{role, content}` messages, optional `response_format` json_schema, and **no
`tools` or `tool_choice` member at all** — the CLI's per-call `session_title`
request carries both and is refused locally. Every settled request appends one
`kind: "inference"` row (`purpose`, `grant`, `request`, model, usage,
`usage_source`) to `service.json` v2's optional `inferenceLedgerPath`, which
may never be a subject ledger; readers dedupe on `(grant, request)`
(`dedupeInferenceUsageRows`), and `wakeFuse.ts` skips inference rows. Without
that path every grant request is refused `unavailable`. Grants share the
subject's credential authority, so a stale realm fails both (accepted shared
fate): the grant request is refused `auth_stale`, and a proxied grant request
that meets a stale realm gets HTTP 401 `{"error":"auth_stale"}`, which the CLI
surfaces immediately as `Internal error: "Unauthorized (401) from …:
auth_stale …"`. `grokInferenceClientConfig.ts` renders the evaluator's private
`GROK_HOME` `config.toml` (pinned per model/effort in the manifest): the grant
token through `env_key = "DAIMON_INFERENCE_GRANT"`, the worker's lean settings,
no MCP, and `max_retries = 0` — with the default, Grok retries a refused (503)
request with backoff past 45 s instead of failing in ~0.35 s. Its init frame
reports `apiKeySource: "user"`, `tools: []`, `mcp_servers: []`, and the CLI
must be run with `--model daimon-inference-grok`. The inference ledger
directory must be provisioned setgid to the organization group (e.g.
`2100:2000 2750`) for uid 2000 to read rows the broker creates `0640`.

Every model block the worker can reach carries `max_retries = 0`. Grok 1.0.34's
default retries a refused or failed request with backoff **past 45 s**, blindly:
one live turn emitted the same refusal fifteen times over five minutes, spent
$0 and died with no account of why. The session-title sink and the evaluator
client (`grokInferenceClientConfig.ts`) always pinned it; the worker's own
model — the single path that spends money — was left on the default, so the one
place a stall costs a wake was the only one that could idle for minutes after
its work was done, silently, because a retried request that never reaches
upstream writes no ledger row and prints no proxy line. Daimon owns the retry
decision here because the thing being retried is Daimon's own proxy: a
genuinely transient fault is already answered 503 and is the broker's to
retry, and everything else is a refusal that repeating cannot fix. The worker
fails fast instead and the turn reaches the host with a status. These bytes are
manifest-pinned per model and effort, so changing them rotates
`GROK_ENGINE_BROKER.worker.configSha256` and every deployment must re-vendor.

`grokBrokerProjection.ts` is the public, I/O-free projection of one brokered
Grok agent's slot (`noopolis.daimon.grok-broker-projection.v1`): Daimon's own
deny collectors plus the caller's evaluator paths, profile/config/prompt
digests, pinned executable, model, limits and ledger. A Grok agent must declare
`model` and `reasoningEffort` for it; nothing is defaulted, and a supplied
profile digest that differs is refused. Paths are never resolved: Spawnfile
must supply canonical non-symlink paths (its fixed tmpfs and workspace roots)
and verify that during provisioning. The projection also carries the seccomp
profile digest and the `bubblewrap` sandbox runtime a receipt must match. `grokSlotPreflightReceipt.ts` is the
zod schema a root slot supervisor's receipt must satisfy
(`noopolis.daimon.grok-slot-preflight.v2`, fixtures under
`fixtures/grok-slot-preflight/`); `verifyGrokSlotPreflightReceipt` binds it to
the projection digest and requires a denied canary for exactly every deny path.
The projection digest does not change across recycles, so the receipt also
carries freshness: a supervisor-owned per-slot `generation` (strictly
increasing) and the caller's recycle `nonce` (32 random bytes, hex). The
verifier requires `{expectedNonce, minGeneration}` and refuses another nonce, a
lower generation, and any v1 receipt.

`grokBrokerWorkerConfig.ts` is the only source of worker `config.toml` bytes;
the manifest pins the sha256 of every model/effort combination and the broker
refuses a turn whose worker config does not hash to the declared one. Three
1.0.34 facts shape it, each verified against a loopback stub model:
`[auth_provider.*]` helpers never run for a custom model, so the turn's proxy
capability reaches the model through `env_key = "DAIMON_PROVIDER_CAPABILITY"`
set by the native launcher (as exposed as `DAIMON_MCP_CAPABILITY`); the
per-turn `session_title` request cannot be disabled by any key, so
`[models] session_summary` points it at a hidden model
(`GROK_SESSION_TITLE_SINK_MODEL_ID`) whose `base_url` is the broker's own
provider proxy and whose `api_key` is a placeholder too short to ever be a turn
capability — so the request does reach the proxy and is refused there, before
any capability lookup, isolation guard, credential read or upstream call, and
Grok falls back to the truncated prompt as the title. That refusal and a bare
unauthenticated `GET /` probe are the two requests a healthy turn always makes
and the proxy never forwards; neither prints a `refused:` line, because for as
long as they did, every healthy turn read as broken. Every *other* refused
request does name itself on the broker's stderr, and a fault that is not a
`GrokBrokerProxyRefusal` names its own class and message beside
`broker_unavailable` — `[grok-proxy] refused: broker_unavailable (TypeError:
…)` — because the bare word carries no diagnostic content and is answered 503,
which Grok blind-retries: one live turn emitted it fifteen times over five
minutes, spent $0, and died with no account of why. That cause is the error's
class and message, plus one level of its own `cause` — every failed provider
`fetch` is `TypeError: fetch failed` and names nothing without it, so the line
reads `broker_unavailable (TypeError: fetch failed <- Error: ENOTFOUND)`, an
errno cause with no message named by its `code`. Nothing else: never a body,
bearer, capability, session id or
header. It is redacted through `redactCredentialText` with that request's own
capabilities as exact secrets and the `CLI_ENGINE_MAX_DIAGNOSTIC_BYTES` bound,
flattened to one line, exactly as the failed CLI child and the launcher's
worker diagnostic are. It is a log line only: the 503 is unchanged, because a
genuinely transient fault is still transient.

One fault is *not* transient and no longer wears that shape: a fenced
credential realm. `isStale()` is checked on the turn path before the
credential read, and the request that discovers the fence (the authority's own
generic error) is promoted to the same refusal, so a stale realm is a named
400 `auth_stale` instead of one 503 plus fourteen blind retries — the training
login expired at 22:28Z and the 22:48Z run spent five minutes and $0 learning
nothing. `ENGINE_BROKER_AUTH_STALE` (`engineBrokerProtocol.ts`) is the single
name behind the turn failure code, this refusal reason and the grant path's
401 `GROK_INFERENCE_AUTH_STALE_BODY`; the grant path keeps its own 401 shape,
and the title sink keeps its 503 on a fenced realm like everywhere else.

The sink keeps that 503
shape because every live capture was taken with it: forcing 400 and 503 there
were both observed to end the turn `exit=0, result: success`, so a hard 4xx on
that request does *not* end Grok's session. And effort is only sent when the
model declares it, so the declared effort is
the model's single `reasoning_efforts` entry. HTTP MCP needs CA certificates in
the image even for a loopback `http://` URL ("Failed to build HTTP client").

`engineBrokerMcpFacade.ts` is the worker's only route to its per-wake MCP mount
and rebuilds every header from a closed allowlist in both directions, so the
worker's bearer never reaches the mount and no mount header reaches the worker
uninvited. That allowlist must include the Streamable HTTP transport's own
routing headers or the route does not exist: forwarding only
`content-type`/`accept` destroyed `Mcp-Session-Id`, so `initialize` returned 200
while every request after it — `notifications/initialized`, `tools/list`,
`tools/call` — came back HTTP 400 `Mcp-Session-Id header is required`, and the
model saw `search_tool` answer `{"results":[],"total_hidden_tools":0,"status":
"partial"}`. Client to mount: `content-type`, `accept`, `mcp-session-id`,
`mcp-protocol-version`, `last-event-id`. Mount to client: `content-type`,
`mcp-session-id`, `mcp-protocol-version`, plus the facade's own
`cache-control: no-store`. The session id is an opaque routing value and is
never logged or ledgered. The facade also carries the three methods the
transport uses — POST, the standalone `GET` SSE stream that is the only route a
server notification or progress frame can take, and the `DELETE` that ends a
session — and streams each body rather than buffering it, because a GET tunnel
stays open for the whole session. Streaming means backpressure, and a
backpressured tunnel must never park: `awaitMcpTunnelDrain` races the client's
`drain` against its `close`/`error` and the turn's abort, because a bare
`once("drain")` cannot fire for a client that hung up mid-write and left the
handler — and the upstream call it was relaying — awaiting for the life of the
process, with no status, no refusal and no line anywhere to read. Every
outcome but a real drain rejects, so the relay tears the tunnel down instead
of writing into a socket that is gone. Never widen it into a transparent proxy: the
whole point of the boundary is that the allowlist is closed.

The facade is also the only place an MCP tool call is observable *while it is
still running*. Daimon writes a tool receipt on completion, so a call that
started and never returned is byte-identical, in every artifact, to a call that
was never made — and that was the last unlit path under a live hang where the
worker stopped acting after its eighth provider response, the per-request
ledger published `open: 0`, and the trial deadline killed it seven minutes
later. `engineBrokerMcpCallLog.ts` records each relayed `tools/call` POST and
whether the facade ever answered it, and the observation rides the *sealed
terminal response* of a failed turn (`mcpCalls`, optional and v2-only) —
the seam the worker's redacted last words and the sealed usage already take,
because the slot's control root is tmpfs that dies with the container. It
replays with the record and reaches the operator through
`engineBrokerControlClient.ts` as `mcp=<answered>/<started> answered` plus
`mcp_outstanding=<tool>@<ms>ms`. Its rules are the per-request ledger's: names
and timings only (never arguments, never a result, never a session id or
bearer; a name that is not a plain short identifier is `<invalid>`, and the
list is bounded with a `<truncated>` last entry); absence stays absence (a turn
the facade never registered observes as *nothing*, a turn that called nothing
observes `started: 0`, and a POST body the facade could not read counts in
`undecoded` rather than inventing a name); and it can never fail, delay or
refuse a turn. "Answered" means one thing and it is load bearing: the relay
reached its own `end()`. A tunnel torn down when the worker dies did not
answer, so the call it was blocked on stays outstanding with the elapsed time
it had reached — otherwise the turn's death would erase the evidence the
instrument exists to keep.

The facade relays one more thing, for the whole session, and until now wrote
nothing about it. A `tools/call` is a POST that answers; the standalone `GET`
SSE tunnel is the route a server notification or progress frame takes, and it
stays open from `initialize` to the worker's own shutdown. A worker parked
reading it was, in every artifact the broker wrote, identical to a worker doing
nothing: every provider request closed, every tool call answered, idle to the
deadline. `EngineBrokerMcpCallLog.openTunnel` records that lifecycle on the same
observation — `tunnels: {opened, closed, delivered, open: [{openMs, delivered}]}`
— so a turn sealed with one still open says so and says how long it had been
open, and `delivered` separates a tunnel actively carrying frames from one held
open having received nothing, which is the difference that decides whether it is
the blocker. Bounded at `ENGINE_BROKER_MCP_TUNNEL_MAX` open entries (a session
opens one), counts and elapsed milliseconds only, never a frame, an event
payload or a session id. It is *observation only*: nothing here closes, times
out or refuses a tunnel, because an instrument that tore the stream down would
destroy the evidence it exists to gather. The member is optional on the wire for
one reason — a turn sealed before it existed must still replay — so its absence
means "not measured" and never zero, exactly as `mcp`'s own absence does.
A request the facade *refuses* is the sharpest form of the same silence, and
it used to observe as nothing at all: `route()` threw before `calls.begin`, so
a turn 403'd on every request sealed `answered == started, outstanding: []` —
byte-identical to a healthy turn. `EngineBrokerMcpCallLog.refuse` now counts
each one by a closed reason class (`route`, `expired`, `exhausted`,
`unrouted`, `oversized`), because the classes call for opposite fixes: an
exhausted per-turn capability is a budget, an unserved route is a worker
asking for something that does not exist. That budget is *derived*, not
picked: `ENGINE_BROKER_MCP_CAPABILITY_REQUESTS` is `GROK_WORKER_MAX_TURNS`
times `ENGINE_BROKER_MCP_ROUND_REQUESTS` (3 — a round's `search_tool`, its
`use_tool`, and one spare for a retry or a second discovery) plus
`ENGINE_BROKER_MCP_SESSION_REQUESTS` (5 — `initialize`,
`notifications/initialized`, `tools/list`, the GET tunnel, the DELETE). It was
a literal 128 against a bound of 48 rounds whose legitimate traffic is ~101, so
the first round that also retried met a mid-turn 403 storm; the two numbers
that must agree now live in one place, and raising the turn bound can no longer
silently exhaust the budget. It stays a bound rather than a comfortable number
because the derivation is exact: the request *after* the worst-case legitimate
session is refused, so a compromised worker gets three MCP calls per round it
was compiled to take and not one more. `engineBrokerMcpObservation.test.ts`
drives that worst case through the real facade, computed from the turn bound
alone. Attribution comes from
`EngineBrokerCapabilities.classifyToken`, which names the token's turn and why
it would be refused *without spending its budget*; a bearer no grant matches
names no turn and stays unattributed, because guessing an owner would be
inventing the measurement. Counts only: never the token, the capability, the
URL or the body. The member is optional on the wire for `tunnels`' one reason,
and reaches the operator as `mcp_refused=exhausted:41` and the seal row's
`mcp.refusals`.

Measured against the real CLI (rig, grok 1.0.34, real facade and mount): the
tunnel opens ~3 ms after `initialize`, carries nothing for its whole life, and
**closes 16 ms before the worker exits** — the close is the worker's own
shutdown, not the facade's. A turn that never reaches that shutdown is the one
that seals with it open; a deliberately stalled `tools/call` sealed
`open: [{openMs: 14652, delivered: false}]` beside its outstanding call.

That seam is enough for a turn that *fails with a reply* and not for the turn
the instrument was built for. A worker that crashes still produces a terminal
response; a worker that HANGS is cancelled by its client's deadline, and a
cancelled turn has no client left to answer, so the sealed response — with
`mcpCalls` and the worker's redacted last words riding on it — is sealed into a
turn record in the broker's own `0700` turn store and dies with the slot's
tmpfs. Six live runs reproduced that exactly. What *does* survive a slot is the
broker's ledger directory, which Paideia already recovers `usage.jsonl` and
`requests.jsonl` from on the failure path, so `engineBrokerSealLedger.ts` writes
a third stream beside them: one `noopolis.daimon.turn-seal.v1` row per sealed
terminal turn (`turns.jsonl`, `engineBrokerSealLedgerPathFor`), rendered from
the sealed response and nothing else. Its members are the accounting, the
failure `code`, the diagnostic's closed `status`/`stage`/`failure_class` with
the reason `engineBrokerNativeClient.ts` already redacted and bounded, and the
facade's `mcp` observation — names, counts, refusals by reason class,
GET-tunnel lifecycle and elapsed milliseconds. That projection is a closed
allow-list and `engineBrokerSealLedger.test.ts` asserts the *exact key set* of
a written row for a completed turn: replacing it with `...terminal` writes
`usage`, `diagnostic`, `mcpCalls` and the model's entire reply into the
ledger, and that mutation is what the assertion exists to catch. Never a
prompt, body, reply, bearer, capability or session id; the terminal response
carries none of those in the first place, and the projection is an allow-list
rather than a spread, so a future additive member of the response cannot become
a ledger field by accident.

Two invariants make it worth having. The row is rendered for *every* terminal
turn including one whose `usage` is `null` — a turn cancelled before any spend
could be attributed writes no usage row at all, and is precisely the turn whose
outstanding call has no other route out. And absence stays absence three ways:
no `mcp` member when the facade never observed the turn, `started: 0` when it
observed a turn that called nothing, and no row when nothing sealed. Reading
any of those three as another is the failure this stream exists to prevent. The
line is sealed into the turn record's ledger bytes with the other two and
appended last, so a replay completes an interrupted append the same way and
readers dedupe on `turn`; `seal` is optional in `parseBrokerTurnLedgerLines`, so
a record written before the stream existed still replays. It is advisory
throughout: `recordLedgerLines` swallows every I/O fault, and nothing here can
refuse, delay or fail a turn.

Worker `GROK_HOME` layout the deployment must provision (attested before every
turn by `grokWorkerHomeAttestation.ts`, recorded in `GROK_ENGINE_BROKER.worker.home`):
`$GROK_HOME` and `$GROK_HOME/sessions` `root:<worker> 1771`; `config.toml`,
`sandbox.toml`, `trusted_folders.toml` (empty), `managed_config.toml` (empty)
and `requirements.toml` (empty) `root:root 0444`; and
`sessions/sandbox-events.jsonl` `<worker>:<broker> 0640`. Grok 1.0.34 writes its
sandbox events there (the root `sandbox-events.jsonl` stays empty) and runs
every profile inside bubblewrap, where a non-empty `deny` list is enforced;
`grokWorkerSandboxProfile.ts` renders those profile bytes. A worker-uid process
can neither write, rename, nor unlink any of the root-owned files.

Deny-path placement (`grokWorkerDenyPlacement.ts`). Grok 1.0.34 materializes
every `deny` entry inside bubblewrap **as the worker uid**, bind-mounting
`$GROK_HOME/sandbox-blocked-{file,dir}` over the target, so an entry is
placeable only when every ancestor directory is searchable by that uid and the
target already exists and is not a symlink. One unplaceable entry makes Grok
refuse the *whole* profile (`bwrap: Can't create file at …: Permission
denied`), so every turn of that worker fails, not just that path. Matrix:
`.runtime/grok-deny-placement/EVIDENCE.md` in the ecosystem folder. The rule
therefore has two halves:
- shape, decidable without a filesystem and asserted by the renderer: canonical,
  and strictly below every base-profile grant (`GROK_WORKER_BASE_PROFILE_GRANTS`);
- placement, asserted by whoever provisions the paths — root provisioning and
  every slot recycle on the Spawnfile side, `prepareGrokWorkerAttestation`
  before every brokered turn, and `prepareAndVerifyGrokSandbox` on the direct
  path, which runs as the worker uid itself. The broker (uid 2100) cannot
  descend into a `2000:<worker> 0710` runtime home, so an `EACCES` below an
  ancestor the worker *can* search is left undecided there; root, which holds
  `CAP_DAC_READ_SEARCH`, decides every entry.

When a protected path is not placeable, the deny entry is **lifted** to the
nearest ancestor that is — never adding `o+x` to a private directory, because a
lift masks a superset and never widens the worker's reach. The durable
wake-acceptance store is exactly that case: it lives under the organization's
`state` directory, which the ownership guard secures `2000:2000 0700`, so the
mask goes on that directory (`acceptanceStoreDenyPath` in
`grokBrokerProjection.ts`, which refuses a mask that does not contain the
store).

Temp and spill isolation (`grokWorkerTmpAttestation.ts`, checked before every
turn; `GROK_ENGINE_BROKER.worker.home.{privateTmp,sharedTmp,spillDirectory}`).
Grok 1.0.34's strict profile grants shared `/tmp` and `/var/tmp` read-write
and refuses to start if either, or any path equal to or above a base grant, is
in `deny` (verified: `/tmp`, `/var/tmp`, `/run`, `/etc`, `sessions` all fail;
`/tmp/sub` works), so the profile cannot hide evaluator temp files. Instead:
- the launcher exports `TMPDIR=<worker home>/tmp` (strict adds TMPDIR to its
  read-write grants; Python, Node and `mktemp` use it); provision it
  `<worker>:<worker> 0700`. Every registered worker's private temp is attested
  before any turn, so one misprovisioned sibling refuses all turns;
- `/tmp` and `/var/tmp` must be `root:<non-worker group, e.g. org 2000> 1774`:
  Grok needs to open the directory, but without search or write a worker can
  only list names — `cat`/`read_file` get EACCES and it cannot create files.
  `1770`/`1771` make Grok refuse the profile; `1775`/`1777` leak. Any non-root
  process outside that group that needs temp space must get its own `TMPDIR`;
- the organization runtime home of a brokered Grok agent is `2000:<worker gid>
  0710` — traverse-only, so the worker can reach `tool-output/` and nothing
  else. `physicalReadiness.ts` accepts exactly that shape for a `grok` agent
  (owner the runtime user, mode `0710`, group a worker group that is not the
  runtime's own) and keeps the plain `0700` rule for every other engine; wider
  (`0711`, `0730`, `0750`, `0770`, any world bit, setgid) is refused, and so is
  a `0700` home for a Grok agent, because its worker could not read its own
  spills. Everything Daimon creates inside a runtime home is `0700`
  (`runtimeHomeLayout.ts`: telemetry, turn traces, world trajectories,
  `tool-state`, the engine XDG directories, `.tmp`), so a traversable home
  still exposes nothing but `tool-output/`. A deployment-provisioned memory
  home under that runtime home must stay `0700` for the same reason. That mode
  is *asserted and corrected*, not merely passed to `mkdir`, because `mkdir`'s
  `mode` decides nothing for a directory that already exists: a `telemetry/`
  left at `0755` by a pre-branch Daimon or pre-created by a deployment stayed
  `0755` forever, and under a `0710` home that is the worker reading its own
  agent's prompts, replies and causal history. `ensureRuntimeHomeDirectory`
  walks every level below the home, opens each through
  `O_DIRECTORY|O_NOFOLLOW` and `fchmod`s the directory it stat'd; one owned by
  another uid is **refused**, never widened, and a symlink planted where a
  directory belongs is refused rather than followed. The home itself is
  create-only (`ensureRuntimeHome`) — whether it should be `0700` or a Grok
  agent's `0710` is `physicalReadiness.ts`'s judgement, not the layout's. The
  mode constant lives only in that module, a test fails the build if any writer
  imports it again, and the same test refuses any `mkdir` that names a runtime
  home outside the layout — a `mode:` argument covers only the install where
  the directory is new. `wakeAcceptanceFs.ts` is the one exception and closes
  the hole the other way, by asserting the directory it found and refusing a
  wider one;
- spills (`toolResultSpill.ts`) are written `0640`; provision
  `<runtimeHome>/tool-output` as `2000:<worker gid> 2750` (setgid) under a
  runtime home the worker can traverse, so each spill carries that agent's
  worker group and no other worker can read it. The writer pins the directory
  (`O_DIRECTORY|O_NOFOLLOW`, dev/ino re-checked before publishing) and refuses
  one that is a symlink, not owned by the runtime, wider than `2750`, or
  group-open without setgid or in the runtime's own group; it cannot tell
  *which* worker gid belongs to the agent, so that mapping stays the
  deployment's. A spill is published by rename, replacing any existing entry
  (a planted symlink included) without following it.
- registered workspace and home paths must be canonical (no `.`, `..`, empty
  components or trailing slash) in both `service.json` and `registrations.bin`;
  the launcher refuses the slot otherwise.

`agySubscriptionRealm.ts` owns the one host-level private D-Bus/Secret Service
realm, durable keyring lease, bounded unlock stdin, and cleanup.
`agySubscriptionBootstrap.ts` owns only the interactive first-enrollment AGY
child; normal engine dispatch remains in `engineDispatcher.ts`.
`portableCredentialMaterial.ts` imports bounded Codex ingress into its
runtime-writable home without clobbering a newer CLI-refreshed credential.
`grokSubscriptionRealm.ts` owns the single durable rotating Grok credential,
the lifetime lease, crash journal, stale fence, and serialized per-turn
stage/promote cycle while each agent retains private non-auth home state.
`../pi/grokSandbox.ts` owns the direct (non-broker) Grok process boundary: it
replaces the provider's fail-open built-in profile with an exact custom profile
denying the realm, bootstrap, and peer roots, and requires a kernel-enforcement
event (read from `$GROK_HOME/sessions/sandbox-events.jsonl`) before every Grok
turn. The direct path registers its per-wake MCP endpoint in the agent's
Daimon-owned `GROK_HOME` config (`../pi/grokHomeMcpRegistration.ts`), because
1.0.34 skips project-scoped MCP servers in untrusted workspaces.
Strict Codex uses its native permission profile only for model-run local
commands: the profile denies current `.codex/auth.json`, current
`.daimon-inbound`, `/proc`, `/run`, shared protected stores, and peer roots
while preserving Codex's own helper files, the workspace's prepared resource
symlink reads, and the current agent's `tool-output/` spill reads. Codex
provider traffic and trusted MCP/provider processes stay outside that native
command sandbox and must keep their own auth.
`organizationRuntimeReadiness.ts` composes portable credential preparation,
AGY realm readiness, and physical path authority before any agent starts. AGY
fails closed on enrolment: `verifyAgySubscriptionEnrollment` runs there at host
start and again through `prepareEngineReadiness` before and after every wake,
so an unenrolled realm or an unopenable keyring refuses the agent with "run the
Daimon AGY bootstrap command" rather than producing credential-less turns.

All three engines now get the same per-wake MCP tool surface. AGY reaches it
through `../pi/cliMcpRegistration.ts` (`agy mcp add --type http` into the
agent's own `$HOME/.gemini/config/mcp_config.json`, removed again after the
turn) rather than a command-line flag, because AGY has no equivalent of Codex's
`-c mcp_servers.daimon.url=`. `AGY_MAX_TOOL_TURNS` in `../pi/cliSession.ts` is
the only place its per-wake tool-call bound is decided. `maxToolTurns` only
mediates daimon-MCP tool calls; Codex's own shell (`exec_command`) is never
routed through it, so Codex gets its own bounds instead —
`DEFAULT_CODEX_WAKE_TIMEOUT_MS` (wall clock) and
`DEFAULT_CODEX_WAKE_TOKEN_CEILING`, both in `../pi/engineWakeLimits.ts`, overridable
via the engine-neutral `DAIMON_ENGINE_WAKE_TIMEOUT_MS`/`DAIMON_ENGINE_WAKE_TOKEN_CEILING`
(the `DAIMON_CODEX_*` names are aliases; conflicting values are refused), which
the dispatcher also passes to the Grok broker as lowering limits. The token
ceiling can only be checked when Codex reports it: its `--json` stream carries
usage exactly once, on the turn's own `turn.completed`, so crossing it kills
the child immediately and fails the wake instead of letting an over-budget
turn resolve as a normal success; the wall-clock bound is what actually
interrupts a runaway turn in progress.

`turnUsageLedger.ts` is engine-neutral: the Grok broker appends through
`finishBrokerTurnWithUsage`, and AGY and Codex — neither of which has a
broker — both append through the session's `onTurnUsage` sink wired in
`engineDispatcher.ts`, fed by their own decoded terminal-frame usage
(`agyHeadlessResult.ts`, `codexHeadlessResult.ts`). `wakeFuse.ts`'s token
ceiling depends on every engine actually reaching this ledger — a
missing/unreadable ledger is a startup failure there, on purpose, rather than
a silent zero that would let the ceiling sum nothing.

A wake that *fails* spends the same money as one that publishes, so usage is
recorded whenever the engine actually reported it, not only when the wake
succeeded. For Codex that means `../pi/cliChildOutput.ts` hands each parsed
`turn.completed` frame's decoded usage to the session as it streams, and
`../pi/cliSession.ts` meters it on the breach, timeout, non-zero-exit, and
rejected-turn paths as well as the published one. The row's `outcome` field
(`completed`/`failed`, plus a closed-vocabulary `reason`) is what tells them
apart; it is an additive field inside the unchanged
`noopolis.daimon.turn-usage.v1` record, because Spawnfile's reader drops every
line whose `v` it does not recognise while ignoring fields it does not know.
Absence of reported usage is still absence: no `turn.completed`, an
undecodable usage block, or two completion frames all write nothing, because a
zero-filled row is byte-identical to a real zero. Before this, a breached
ceiling recorded nothing at all and its spend survived only inside the error
message.

`turnRequestLedger.ts` is a *second*, separate stream beside that ledger, not a
wider row in it. The per-wake row is one sum and cannot distinguish a fixed
prefix replayed once per model request from a context that grows per request —
the two call for opposite optimisations, and 55 production wakes (14,890,263
input against 159,726 output, context flat at 23–32k per request regardless of
request count) look like the first without proving it. `../pi/cliChildOutput.ts`
carries the thread id off Codex's own `thread.started` frame, and
`../pi/codexRolloutUsage.ts` reads that thread's rollout under
`$CODEX_HOME/sessions/**` for the per-request `token_usage_record` frames the
`--json` stream never emits. Each Codex row carries its own `started_at`/`ended_at`
from the rollout frame timestamps (end = the usage frame; start = the first
non-usage frame after the previous request's usage frame, else that request's
end), absent rather than substituted when a frame has no valid timestamp. Rows go to `requests.jsonl` beside `usage.jsonl`
(`DAIMON_TURN_REQUESTS_LEDGER_PATH` relocates it) under the same invariants: a
wake whose rollout is absent, unreadable, or undecodable writes *nothing*,
because a fabricated zero is byte-identical to a measured one; and every failure
is swallowed, because instrumentation must never fail a wake. The existing
ledger's version, path, and field list are untouched, so Spawnfile's
`v`-pinned reader is unaffected.

Each Grok row also carries `tool_calls`: the tool-call NAMES that request's
response carried, read by the proxy from the body it already buffers for usage
(`parseGrokResponseToolNames` in `grokBrokerTurnMeter.ts`). Timings and tokens
alone cannot answer "did the model ever *try* to call `use_tool` or
`search_tool`", which is exactly the question two live turns left open. Names
only — never arguments, never message content, never a bearer; a `name` that is
not a plain short identifier is recorded as `<invalid>` rather than passed
through, and the list is bounded at `GROK_REQUEST_TOOL_CALLS_MAX` (16) entries
with a `<truncated>` last entry, so a pathological response cannot write an
unbounded row. Absence stays absence, as everywhere in these ledgers: a decoded
response that called nothing records `[]`, and a response that could not be
decoded records *no field at all*, because a fabricated empty list is
byte-identical to a measured one. On the stream row path the names are attached
only when the proxy's timings and the worker's stream requests are aligned
request-for-request, since an unaligned index would credit one request's attempt
to another. The *usage* decode beside it is wrapped the same way, and for a
sharper reason: the upstream call has already succeeded, so a decoder fault
that failed the request would throw away a response the broker paid for and
have Grok buy it again. A fault there falls through to the documented estimate
(`ceil(bodyBytes/2) + 4096`, `usage_source: "estimated"`, counted in
`estimated_requests`) — never to zero and never to absence, because the
ceiling must still count what was spent. It is an additive field inside the unchanged
`noopolis.daimon.turn-requests.v1` row and deliberately not a version bump:
Spawnfile's reader pins `v` and ignores fields it does not know, and Paideia
only relocates this stream's path. The whole path is advisory — the parse is
wrapped, and nothing it does can refuse, delay, or fail a turn, or reach the
spend gate.

`testRuntimeSubprocess.ts` is an unexported, explicit-test-only JSONL process
surface for exercising the real control, schedule, and acceptance paths with a
controlled clock and deterministic scripted cognition. Its ephemeral loopback
HTTP listener exposes only the authenticated v2 wake-acceptance route needed by
transport integration tests. Optional bounded cognition actions invoke the real
Moltnet CLI with an explicit compiled client config, and may address only
declared networks and room/DM surfaces. Optional stdio MCP calls consume only a
Spawnfile-compiled, digest-attested test artifact and enforce its agent/server/tool
allowlist. These modules build only into `dist-test-runtime`, never production
`dist`, and remain inert unless the fixed test-mode environment gate is present.
The optional container fixture for that explicit test runtime lives at
`src/runtime/fixtures/Dockerfile.test-runtime`.

Every agent-facing tool in `productionAgentTools.ts` must return its payload in
`details`, not only in `content`. The MCP mount lowers `details` to
`structuredContent` (`src/mcp/toolServer.ts`) and the engines render that in
preference to `content`, so a tool that fills only `content` reaches the model
empty. `moltnet_read` shipped that way and returned nothing but a message count
for its whole life; `memoryTools.ts` and `worldTools.ts` are the pattern to copy.

The declared `mcp_*` tools had the same defect one layer wider: every one of
them returned `details: { server, tool, is_error }`, so an agent calling *any*
declared MCP tool read routing metadata where the tool's own answer should have
been — and, on a failure, read `is_error: true` with no reason for it.
`mcpToolResult.ts` owns that lowering now, under three rules. **Both channels
always carry the payload**, each mirroring whichever one the server left empty,
because being wrong again about which channel an engine renders must cost
nothing; an upstream `structuredContent` is forwarded verbatim so a declared
`outputSchema` still describes what the model sees. **`isError` is raised, not
reported** — Pi's `AgentToolResult` has no error channel, so a failing upstream
tool throws `McpToolCallError` carrying the server's own words, which
`toolServer.ts` lowers to `isError: true` plus that sentence. **The bound
truncates rather than refusing**: an oversized result degrades to a head of
itself plus an explicit marker naming both sizes, where it used to be thrown
away whole. The wake-scoped receipt stores the rendered result so a repeated
identical call replays the answer instead of a digest of it, and a repeated
failing call fails again for the same stated cause.

`toolResultSpill.ts` adds the bound that `mcpToolResult.ts` never had: a
*context* bound, as opposed to a receipt bound. Every tool result stays in the
transcript for every subsequent model request of the wake, and production agents
make 3–37 tool calls per wake against a context that is flat at 23–32k tokens per
request, so one oversized result is not paid once — it is re-billed on every
request that follows it. The 61,440-byte bound in `mcpToolResult.ts` is the
receipt's bound and degrades to a *head only*, unrecoverable. Above
`DAIMON_TOOL_RESULT_MAX_BYTES` (default 16 KiB, ≈4k tokens — a sixth of one
request, where oh-my-pi's 50 KiB default would be half of it) the complete
payload is written under `<runtimeHome>/tool-output/` and the model receives head
**and** tail plus a notice naming the absolute path and the shell command that
reads it. Naming the path is the point: a bare `[truncated]` makes the agent
re-run the same expensive call. Three rules, all borrowed from
`references/oh-my-pi`'s `tools/output-meta.ts`: a failed disk write still
truncates and only withholds the recovery link, never re-exposing the payload; a
result at or under the bound passes through **byte-identical**, so the
`mcp_*` passthrough contract above is untouched for the overwhelming majority of
results; and `DAIMON_TOOL_RESULT_NO_TRUNCATE` exempts named tools outright, for a
deployment where one declared tool's whole answer is load bearing — Daimon cannot
know which, so that judgement stays with whoever declared the tool. Daimon's own
`moltnet_read`/`moltnet_send` are outside this wrapper by construction: they are
already byte-bounded at `MAX_RESULT` and `moltnet_read` pages with a cursor, so
the agent bounds them by asking for less rather than by being handed less.

Daimon does not re-declare an upstream `outputSchema` on its own mount: a
declared output schema obliges every result to carry conforming
`structuredContent`, which neither a content-only response nor a truncation
marker can satisfy, so declaring it would turn a degraded result back into a
lost one. For the same reason `toolServer.ts` names the failing instance path
and keyword when Ajv rejects a call — `Invalid arguments for tool X` on its own
leaves trial and error as an agent's only route to a tool's argument shape.

`fixtures/testMcpServer.mjs` has to keep modelling a server that answers the way
real ones do — content only, structured only, both, an `isError` refusal
carrying its own reason, and a result past the bound. It was a single
never-failing text-only tool, which is exactly why a passthrough that dropped
every payload passed every test.

`moltnet_read` also has to page. Moltnet's frozen machine wire caps a response
line at 16384 bytes and any single message part at 4096, and `projectRead`
refuses an oversized page with `error.code: "transport"` rather than truncating
it, so a single large `limit` can never be served on a busy room.
`moltnetMachineRead.ts` owns that adaptation — small pages, cursor following,
adaptive backoff — and Daimon adapts to the wire rather than changing it. A
`machine` error must always surface its own code; the generic refusal it
replaced hid a never-working tool for as long as the tool existed.

Each engine/tool child receives only the current non-secret wake id in
`DAIMON_WAKE_ID`; it is bound for one turn and cleared afterward. Transports
may use it as an idempotency/cause key, but Daimon does not interpret transport
identities or targets.

`attentionDispatcher.ts` owns execution selection from durable deliveries. The
per-agent claim in `wakeAcceptanceStore.ts` atomically binds all selected ids
before any record transition or engine invocation. Never restore batching by
counting arrivals or marking read messages complete. `attention` is opt-in;
unmarked/deferred deliveries wait for new input without a self-wake loop.
Live turn authority is `activity.executions`, independent of receipt completion;
its execution id must equal the engine wake id. Budget pauses retain acceptance,
and operator stop remains a hard latch.

That authority has to outlive the host, because the caller who needs it reads it
last. `activityV2` used to answer `undefined` once `stop()` closed the acceptance
store — HTTP 503 `native_host_unavailable` through a caller's route — and the one
caller that must prove an execution closed asks *after* the runtime stopped: a
harness worker stops its host the moment a delivery closes its execution and
stays deferred awaiting external input. So a trial whose subject really ran,
spent its budget and simply did not do the work could not be told from a hung or
crashed one, and reported as an unscorable infrastructure failure. `stop()` now
seals the projection between the dispatcher's own shutdown — which awaits every
admitted turn, so `executions` is settled rather than momentary — and the store's
close, and `activityV2` serves that seal afterwards with `state: "stopped"`. A
stopped host has *more* certainty about quiescence than a live poll, not less,
because nothing can be admitted after the seal. Three things it is not: a bypass
of the control token, a fabricated idle runtime (a host that never started and
one whose seal could not be read both still answer nothing, because absence must
stay absence), and a claim about the store-backed routes beside it —
`availability` and `wakeReceipt` keep answering `undefined` after a stop, since
neither settles a closure proof. `state` is optional on the wire for the reason
every additive member here is: a projection published before the seal existed
must still parse, and its absence means "not stated", never "running".

Drain is the reversible operator stop (`POST /v2/drain`, `POST /v2/resume`,
`organizationRuntimeControl.ts`). It is a separate, in-process gate and must
never be folded into the fuse: `fuse.stop` is a safety latch that only an
operator removing the file *and* restarting clears, and resume never reopens it
(it checks the hard reason first and the halted dispatcher stays halted).
While drained, `accept` answers `blocked("operator_stop")` — the existing
`work-blocked` reason, because Moltnet's bridge treats any reason outside its
closed list as a hard failure rather than a deferral — and the dispatcher's
`pause()` lets no inbox loop start or admit a turn; a loop that already holds a
claim releases it before `fuse.admit`, so a drain spends no budget. Queued
deliveries stay `accepted`. Availability says `drained` only when no inbox loop
is alive (`quiescent()`), which is the signal a drained release waits for.

Deferral is bounded. A delivery that sits in `accepted` past
`STALE_QUEUED_DELIVERY_MS` (24 h, `wakeAcceptanceRetention.ts`) without a live
claim is no longer offered by `recoverable()`; the dispatcher stops it
`queued_wake_stopped` the first time it meets it and logs
`daimon: wake expired agent=… delivery=… accepted_at=…` on stderr (compaction
still stops any it never met). At 48 h, deliveries from 2026-10-05 were still
being retried, and failing, through the 10-07 edition. Without that bound every
undisposed or failed delivery returned to `accepted` forever, headed every later
batch ahead of new mail, and on 2026-10-05 213 of them (some two weeks old) held
the store at its record bound, so every `POST /v2/wakes` was refused for an
hour. For the same reason terminal compaction keeps the idempotency horizon only
while active work leaves room for it (`terminalFilesToCompact`), opening a store
prunes `.host-online-*` markers of hosts provably dead in its PID namespace
(148 had accumulated, one per crash or recreate, all counting against the
directory bound), and a store over its bound refuses as `WakeInboxFullError` —
the control host's `queue_full`, never a 400 `invalid_request`.

Receipt lookup never scans the store per poll. `GET /v2/wake-receipts/:id` for
an unknown or compacted id used to re-read every record file (~2,100) on each
poll and held an idle host at ~1.4 cores. `wakeAcceptanceIndex.ts` keeps the
acceptance-id → record-file index: own accepts and compaction deletes update it,
and a miss re-lists the directory only when its stamp (inode, size, mtime,
ctime) moved — another process may write the store — reading only record files
whose own stamp moved. A stamp younger than two seconds is never trusted as
unchanged (coarse filesystem clocks), and a hit is always re-read and checked
to still carry the id, so a stale binding can at worst cost a false miss,
never serve the wrong record. `wakeAcceptanceIndex.test.ts` counts record
reads to pin this.

A failed inbox execution is retried **once, at once, under a fresh execution
id** (`daimon: wake requeued once …` on stderr). Keeping the failed execution's
id made every retry the same broker turn — a sealed failure replays forever, a
changed prompt is a turn conflict that reaches the host as `engine broker
unavailable` — and deferring it parked work a turn died on (a token ceiling
right after a validated revision) until unrelated mail happened to arrive. The
bound is the record's `execution_error`: set by a failure, cleared only by a
disposition or a completed execution, so a delivery that fails again is
deferred, with its dead execution id cleared, like any other. A rejected wake
never reached cognition and keeps its id.

A delivery returned to the inbox for restart records the outcome that returned it,
and **only a wake outcome can return one**. `attentionDispatcher` reclaims an
undisposed delivery to `accepted` on exactly one condition — a wake result of
`stopped`, which is also the shape an aborted in-flight wake arrives in
(`organizationRuntimeHost.ts` settles a queued job `queued_wake_stopped` and the
in-flight one `active_wake_aborted`). The dispatcher's own `stopping` latch used to
share that condition, and it is a HOST-LIFECYCLE fact, not a wake outcome: a wake
that *completed* had its evidence discarded because the dispatcher happened to be
halting, and the delivery was recorded `accepted, deferred: false, execution id
retained, no code` — byte-identical to "never ran" and to "ran but forgotten".
Production tolerated that because a restart re-delivers and the agent redoes the
work; a one-shot isolated trial has no restart, so the information was simply lost
and a subject that ran and made a choice reported as an infrastructure failure. It
is the wrong record for production too: an agent that read a delivery and declined
to dispose of it is **deferred**, whichever way the host is heading, and a restart
must not re-deliver it as fresh work. So a completed or failed wake takes the
deferred path regardless of dispatcher state, and `stopping` guards only the
pre-wake path, which is where it belongs — it must never be restored to the
post-wake decision. `WakeReceiptCode` carries `queued_wake_stopped` and
`active_wake_aborted` beside the existing five, because those are the two shapes a
shutdown really gives a wake and neither had an honest name. The wake's own code is
recorded exactly; nothing else names a reclaim, because a plausible name for an
undetermined cause gets acted on and a missing one does not. Two consequences, both
load bearing: `accepted` is the one non-terminal state a record may carry a code in,
since it is the only one reached *from* an ended execution (`running` and
`completed` still refuse one), and `transitionClaimed` no longer carries a code
across a transition — it describes the transition that produced the current state,
and a reclaimed delivery is claimed again later. Widening the enum rotates the
contract manifest digest, so Spawnfile must re-vendor
`contract-manifest.json`/`.sha256` and its pinned constant.


`recording` is an optional data-only per-agent config in both versions. The
caller provisions a private `0700` store outside all runtime/snapshot roots;
sources may be shared or worker-owned, and missing sources are empty captures.
`wakeMomentSnapshot.ts` captures immediately before `attentionDispatcher` invokes
`host.wake`, after claim/admission, and hard-links unchanged files based on SOURCE
bigint `(dev, ino, size, mtimeNs, ctimeNs, mode)`. Never drop ctime: restoring mtime
must not hide an edit. Symlinks are recreated without following; special entries
are skipped and counted; roots over 200,000 entries fail the capture. Dot-only
root ids are encoded; arbitrary delivery ids are hashed only in filenames.

`wakeMomentRecorder.ts` writes one bounded (4 MiB) fsynced JSONL row per attempt,
with the active execution id, delivery metadata, successful roots and bounded
reason-code errors. Recording agents accept only durable inbox dispatch; all
synchronous/legacy host wakes return existing `rejected/durable_inbox_required`.
No config means no recording I/O. A snapshot or row failure
must never fail the wake. Retention prunes expired rows and recognized complete
snapshots but always keeps the newest base per root, including removed roots,
and explicitly protects the just-appended row and all its snapshots. Age comes
from snapshot names; a synced zero-byte `.complete` marker records ownership so
retention never parses manifests. Only the newest link-base manifest is read
per root. Unmarked pairs are preserved for inspection, never reused or pruned.
Rows compaction checks the bounded first line, scans only when it is expired
or every 64 wakes, and renames only when pruning occurred. Name enumeration
still scales with snapshot count; historical file-content reads do not. Keep the data-only `wakeMoments`
manifest capability and emitted digest in sync with these bounds.

The shared manifest bound is 128 MiB of serialized UTF-8, enforced before any
publication. Capture is bounded by 60 seconds across roots; an abort flag checked
between I/O calls and a timer abandon stalled work with `capture_deadline_exceeded`.
A separately bounded one-second finalizer attempts cleanup, error row and retention;
a stalled cleanup cannot block the row. No deadline is caller-configurable.
Shutdown never awaits the abandoned capture. Node cannot cancel an in-flight
syscall, and event-loop stalls can delay timers; late completions issue no further
capture writes. Recursive cleanup checks cancellation between individual calls.

Keep the root descriptor and reverify dev/ino/uid/mode and no symlink components
with the existing path-authority helpers before capture, publication, and every
deletion. A changed root aborts recording, never the turn; log if an error row
cannot be written through the still-trusted store. Node has no openat: like spill
publication, this retains a residual lstat-then-act race, not a race-free guarantee.

Snapshots publish a synced partial directory by rename, then a synced manifest
by rename, then a synced `.complete` marker, then the row. A crash between them can leave partial/orphan captures,
or a row without an invoked turn; recording does not attest execution. Retention
can leave old rows referencing pruned snapshots if interrupted; abandoned partials
and temporary files remain for operator inspection. The snapshot is a point-in-time
copy while this agent is idle, **without locks**: concurrent writers to shared
roots (another agent or long-lived MCP server) can tear files mid-copy or mix
states across files. Detected mutation fails the root, but it is not an atomic
filesystem snapshot. Consumers must never mutate hard-linked snapshot files.
