# Daimon

Daimon is the Noopolis-native per-agent runtime harness.

It defines a small per-agent contract and currently implements that contract on
top of Pi. A Daimon runs one harnessed agent inside a caller-prepared workspace.

Spawnfile compiles and deploys orgs, nested teams, member-owned schedules,
Moltnet wiring, and workspace resources. Daimon executes one agent runtime: it
accepts a wake selected by that runtime's organization policy and runs one
turn. Its strict organization-runtime v2 host owns each configured agent's
durable `cron`, `every`, or `disabled` schedule without learning the Spawnfile
org graph. Simfile and world services do not trigger cognition.

Spawnfile may also compile per-agent production MCP and Moltnet capabilities into this config. Daimon lists each MCP server at startup, mounts only its declared tool allowlist into Codex/Grok cognition turns, and bounds calls to 10 seconds and 64 KiB. Moltnet exposes one scoped natural-language send tool whose deterministic delivery id derives from the active wake, agent, target, and text. Accepted tool receipts are fsynced under the agent runtime home and replayed after restart; transport policy remains Spawnfile/Moltnet-owned.

For a world-capable `kind: every` wake, the harness starts without a decision
token and privately calls `world_claim` before exposing any other world tool.
The claim binds authority to the schedule wake's run/request/wake identity; the
opaque token stays inside the harness. Subsequent observe/affordance/action
calls carry it without placing it in the model prompt or tool schema. Optional
world recommendations are ordinary observation fields discovered after the
independent wake and claim—they are never Daimon wake inputs.

## Install

```bash
npm install @noopolis/daimon
```

The latest published version may differ; this README describes the source tree (0.2.0).

For Pi agents with memory enabled, install Mneme too:

```bash
npm install @noopolis/daimon @noopolis/mneme
```

During local incubation, use the sibling Mneme checkout:

```json
{
  "devDependencies": {
    "@noopolis/mneme": "file:../mneme"
  }
}
```

Pi-specific exports live under the Pi subpath:

```ts
import { PiHarnessAdapter } from "@noopolis/daimon/pi";
```

## Organization-runtime contract

For a strict Codex agent in an already prepared runtime, the public
`resolveOrganizationCodexSandboxProjection(config, agentId, { acceptanceStorePath })`
API returns `noopolis.daimon.codex-sandbox-projection.v1`: canonical workspace/home
paths, the resolved executable, and `sandboxArgs` containing the exact permission
profile rendered for production. Append only `--` and a mechanical command when
checking whether that policy can execute in the caller's container.

The resolver opens and verifies caller-owned path identities and executes the
Codex version probe. It does not import/read authentication, create an agent,
accept a wake or invoke a model. The acceptance-store path must be the same one
given to the control host. This API projects command permissions, not the complete
cognition invocation: Codex's `sandbox` subcommand lacks the strict configuration
flags accepted by `exec`. A caller must therefore use a fresh empty `HOME` and
`CODEX_HOME` and a restricted environment for its mechanical probe. Do not infer
successful tool use or completed agent work from this projection alone.

`@noopolis/daimon/runtime` exports a standard JSON Schema for structural
validation plus the strict, side-effect-free semantic
`validateOrganizationRuntimeConfig` / `parseOrganizationRuntimeConfig` API and
a narrow multi-agent Daimon host:

```ts
import { parseOrganizationRuntimeConfig } from "@noopolis/daimon/runtime";

const config = parseOrganizationRuntimeConfig({
  version: "noopolis.daimon.organization-runtime.v1",
  host: {
    bindHost: "127.0.0.1",
    port: 4318,
    controlTokenEnv: "DAIMON_CONTROL_TOKEN"
  },
  agents: [{
    id: "writer",
    name: "Writer",
    instructions: "Write the report.",
    workspacePath: "/runtime/workspaces/writer",
    runtimeHomePath: "/runtime/homes/writer",
    engine: { kind: "codex" }
  }]
});
```

The package also includes the canonical runtime contract at
`dist/runtime/contract-manifest.json` and its exact-byte SHA-256 sidecar at
`dist/runtime/contract-manifest.sha256`. Every build regenerates both from the
same data-only constants exported as `RUNTIME_CONTRACT_MANIFEST`; the digest is
encoded as `sha256:<lowercase hex>`.

It intentionally contains no teams, roles, parent/member links, wake policies,
deployment settings, Moltnet data, commands, argument arrays, environment maps,
or credentials. V2 agents carry one normalized native schedule; durable state
and acceptance provide restart-safe occurrence execution. `controlTokenEnv` is only the safe name of a
variable; the token value is never serialized. The only organization-host
engine intents are `codex`, `grok`, and `agy`; Pi remains available through the
separate one-agent `@noopolis/daimon/pi` API.

`createOrganizationRuntimeHost(config)` creates an organization runtime host.
Call `await host.start()` to construct one isolated Daimon harness per agent,
after reading the non-blank control token named by `controlTokenEnv`.
It routes only authenticated, targeted wakes; each agent's wakes are serial,
while separate agents can run concurrently. It has no organization or
coordination API. Run the HTTP control process with:

```bash
daimon-runtime run --config /runtime/daimon-runtime.json
```

The process exposes authenticated `POST /v1/wake`, `GET /v1/health`, and
`GET /v1/activity` endpoints. Send the token only as `Authorization: Bearer
<token>`; it never appears in configuration or activity output.

For durable control-plane delivery, provide a caller-created, current-user
owned `0700` directory in `DAIMON_RUNTIME_ACCEPTANCE_STORE`. This enables the
additive authenticated v2 API: `POST /v2/wakes` persistently accepts one
bounded, addressed wake under its `(agent_id, delivery_id, request digest)`
identity before the turn starts, and `GET /v2/wake-receipts/<acceptance_id>`
returns only its strict redacted lifecycle status. The store is a private
runtime authority, not a credential directory; it must be mounted only into
the Daimon host. Equal retries return the original acceptance, while a changed
payload for that delivery id is rejected. `GET /v2/activity` exposes bounded
receipt history and active execution identities. Completed receipts can include
redacted terminal output; acceptance responses never contain model output. If the variable is not
provided, the v1 endpoints remain available and v2 is not exposed.

Per-agent `attention` opts into interruption-aware inbox processing:

```json
"attention": { "maxBatchMessages": 8, "maxBatchBytes": 12000, "maxExecutions": 30, "maxTokens": 3000000 }
```

An idle agent starts promptly. Messages arriving while it works accumulate into
one bounded next turn; manual and scheduled events remain distinct. The agent
uses `daimon_inbox` to read selected deliveries and `daimon_inbox_disposition`
with a `delivery_id` and `complete` or `defer` disposition. Reading a message or
ending a turn never completes it. Unmarked and deferred messages wait durably
for new input, including after restart. A single oversized delivery stays
intact in the inbox tool and is referenced instead of copied into the prompt.
`daimon_continue` with a short `note` schedules one fresh turn of the agent's
own after the current one (one per turn, three in a chain), for work that
should be checked with a clean context, such as write now and verify later.
Omitting `attention` retains single-delivery, automatic completion behavior.
Attention requires the durable control host and `POST /v2/wakes`; synchronous
`POST /v1/wake` rejects attention-enabled agents with `durable_inbox_required`
before starting cognition.

Delivery acceptance does not spend an execution allowance. The existing global
wake fuse counts execution-start reservations, including historical admissions;
optional per-agent execution/token ceilings apply within the same explicit
epoch. Retries reserve another execution while retaining the stable wake id
used by idempotent tools. Reported token usage is a lagging bound, not an
in-flight spending guarantee. Budget pauses preserve and continue accepting
pending deliveries. The inbox has a separate hard storage bound of 2,176
receipts; it never evicts pending work to accept another delivery.

Authenticated `GET /v2/availability` reports running work, pending/deferred
counts, limits, remaining allowances and the pause reason. Global operator-stop
and ledger-failure latches stay hard: HTTP 409 carries a versioned `blocked`
descriptor with a bounded retry delay. A budget pause never becomes a terminal
receipt. Existing fuse trip markers remain latched until explicit operator
recovery; changing attention settings does not erase historical spending.

An operator raises a day's budget without a rebuild or restart by writing
`grants.json` beside the fuse ledger (default
`/var/lib/spawnfile/daimon/usage/grants.json`):

```json
{ "version": "noopolis.daimon.wake-fuse-grants.v1", "epoch": "2026-10-21",
  "organization": { "extra_wakes": 50, "extra_tokens": 20000000 },
  "agents": { "pressman": { "extra_executions": 10, "extra_tokens": 2000000 } } }
```

Each extra is added to the declared limit for the named epoch only (the full
epoch, or its `YYYY-MM-DD` day for the date-derived epoch), so grants only
raise limits and expire by themselves. A malformed file is ignored with one
warning. Parked agents resume within about a second. A wake held by a spent
budget logs `daimon: wake parked agent=… reason=… used=… limit=… epoch=…` once
(and `daimon: wake unparked …` when it clears) and records a `park`/`unpark`
row in `admissions.jsonl`, for host alerting.

`POST /v2/drain` and `POST /v2/resume` (same bearer token) are the reversible
counterpart: a drain answers new wakes with the same 409 `work-blocked`
descriptor, keeps queued deliveries, lets running turns finish and reports
`drain: {state: "draining" | "drained", since}` in availability; resume
dispatches the queue. Neither touches the latched `fuse.stop`.

A batch's atomic per-agent claim records its complete membership and stable
`execution_id` before cognition. Individual receipts retain their delivery ids
and explicit state. `GET /v2/activity.executions` identifies the live turn even
when all its message receipts have already completed; integrations should bind
turn authority to that execution id. The wake environment uses the same id.

Each accepted delivery also has a private, bounded execution claim with an
owner and generation fence. A second host sharing the authority may observe a
receipt but cannot dispatch while the live claimant owns it; only the matching,
unexpired fence can record its terminal state. Claim revalidation and receipt
replacement are covered by a separate exclusive, fsynced per-receipt transition
lock; a recovered generation fences an older paused writer before replacement.
After a host crash, a bounded stale claim can be recovered and replayed. This is durable at-least-once turn
delivery, not exactly-once cognition: if an engine has an external effect and
the host crashes before its terminal receipt is persisted, recovery can run the
turn again. Callers requiring exactly-once external effects must fence or
deduplicate those effects at their own destination.

The durable v2 store is a Linux-container contract. Its non-expiring commit
lock records the owner PID, Linux `/proc` process-start identity, boot id, and
PID-namespace device/inode identity; recovery is allowed only after that exact
owner is proven dead in the same namespace, so PID reuse cannot unlock a live
writer. A different or unobservable PID namespace raises the typed,
path-free `WakeTransitionLockBlockedError` with code
`offline_reconciliation_required`; it is never automatically cleared. For a
replacement container, deployment authority must first prove the prior
container absent or quiescent, then perform an explicit offline stale-lock
reconciliation. On a platform where this identity cannot be proven, v2 fails
closed rather than using a clock-based lock; v1 remains available without the
v2 store.

### Offline transition reconciliation

`reconcileOfflineWakeTransition` is a deployment-admin library operation, not
an HTTP endpoint and never a normal host action. It accepts only the versioned
`noopolis.daimon.offline-transition-reconciliation.v1` request, including the
exact store and lock device/inode identities, owner/generation/PID-namespace
identity, and an opaque absent-or-quiescent deployment attestation. The caller
must mount the store exclusively offline and supply the deployment authority's
attestation verifier. Daimon gives that verifier a canonical immutable
authorization context (deployment identity, nonce, request digest, every
store/delivery/lock identity, and every stale host registration's exact file
device/inode, owner, process, boot, and PID-namespace identity); its returned
proof receipt must echo that exact digest and nonce and certify
`exclusive_store: true`. A same-namespace registration is cleared only when
its owner is proven dead. A cross-namespace registration is cleared only when
the proof authorizes that exact canonical registration digest after deployment
has proven the old container absent or quiescent. Unknown, live, unlisted, or
changed registrations block. Daimon validates the physical store, delivery
record, and lock again immediately before its fsynced removal. The proof
itself is never persisted or returned; the durable redacted receipt records
only cleared registration digests.

The operation writes a durable redacted receipt and returns it on an identical
replay. An identity mismatch, invalid proof, concurrent administrative lease,
or changed replay returns the stable blocked result
`{ state: "blocked", code: "offline_reconciliation_required" }`. It performs
no runtime auto-clear and has no CLI or public-server admin route in C0. The
admin lease itself carries PID/start/boot/PID-namespace identity: a retry may
recover it only after proving the prior owner dead in the same namespace. Lease
unlink and directory fsync failures prevent a successful result; the durable
prepared receipt lets an authorized offline retry finish after a crash.

Every running wake-acceptance store also holds its own fsynced host-lifetime
registration with the same process identity. A host writes that registration
before becoming usable and rechecks the offline lease; the offline operation
takes its lease first, then rejects live or unprovable host registrations.
This permits normal concurrent hosts, but prevents either startup/admin race
from overlapping an administrative reconciliation.

The runtime may bind `0.0.0.0` when its caller places it on a dedicated private
container network. Daimon neither publishes ports nor selects networks; the
deployer must keep the control endpoint un-published and allow only its
authorized control-plane client to reach it.

The JSON Schema is deliberately standard and structural. The pure parser and
validator are normative for semantic checks that standard JSON Schema cannot
express, including unique ids, own-property records, and pairwise
non-overlapping canonical POSIX workspace/runtime-home paths; call the parser
before runtime side effects. The parser canonicalizes absolute path spellings
before retaining or comparing them. Before creating agents, the host verifies
that caller-created roots are real, current-user-owned directories without
symlink components; runtime homes must be exactly `0700`, and workspaces must
not be group/other writable. Daimon never creates or removes these roots.

For a production CLI engine, Daimon resolves the engine from `PATH` once,
pins its canonical executable identity, probes only `--version`, and rechecks
that identity before every child process. Every subscription engine must have a
shared credential owner before the production host becomes ready. Codex and
Grok logins are held only by the auth gateway (`daimon-runtime gateway`), which
owns each private durable realm (`0700`) seeded from its read-only `0600`
bootstrap, refreshes single-flight, fences a rejected login until the operator
supplies a changed bootstrap, and never overwrites newer durable auth from an
unchanged bootstrap. A Codex agent gets `DAIMON_GATEWAY_URL` and its key, never
an `auth.json`; every Grok agent runs through the engine broker, whose upstream
is the same gateway. Without the gateway variables a Codex or Grok agent refuses
to start.

AGY serializes its CLI turns per account because its CLI does not provide a
verified cross-process OAuth refresh lock. Account waiting is bounded to 128
pending operations and 30 minutes, is cancelled when the agent stops, and
happens before the CLI turn timeout starts. Owner shutdown rejects pending work
and drains the active operation before releasing its lease. The native keyring
remains responsible for its own credential representation.

```bash
daimon-runtime auth agy login --config /runtime/daimon-runtime.json
```

The command starts the same realm and launches the pinned `agy` as a Daimon
child with no AGY arguments, allowing its remote URL-and-code sign-in flow.
After the operator exits AGY, Daimon runs the noninteractive enrollment proof
and preserves the durable keyring state. It never accepts a portable AGY token
file, API key, ADC credential, token export, or ambient D-Bus session.

By default, the in-process Mneme runtime uses the same path as each agent's
`runtimeHomePath`. If you need agents to keep separate Pi/runtime directories but
share one memory bank, pass an explicit `memory.runtimeHomePath` in
`PiHarnessOptions`.

```ts
const adapter = new PiHarnessAdapter({
  authPath: "/tmp/daimon-auth.json",
  memory: {
    runtimeHomePath: "/shared/memory/bank"
  }
});
```

Pi agents receive Mneme tools in awake mode for normal work. Dream wakes use a
fresh one-off Pi session under `sessions/dream/<wake-id>-<random>` and inject
the Mneme dream guidance instead. Daimon does not automatically record every
turn as memory; agents write memories only by calling Mneme tools such as
`memory_register`, `memory_summarize`, and `memory_forget`.

## Tests

The package has a non-live test suite covering auth seeding, Pi model config
generation, the harness contract, memory tool wiring, wake and turn traces, and
the org observer:

```bash
npm test
npm run typecheck
npm run build
```

These tests do not call a model provider.

## Model And Auth Helpers

The Pi adapter supports the same model intent shape Spawnfile lowers for Pi:

- OpenAI Codex subscription auth maps to Pi's `openai-codex` OAuth auth store.
- Claude Code subscription auth maps to Pi's Anthropic auth store.
- API-key credentials can be written directly into Pi auth storage.
- Local and custom OpenAI-compatible endpoints render Pi `models.json`.

For Ollama-style local models, use a local endpoint with `auth.method: none`.
Pi still requires an API-key field for custom providers, so the helper writes the
upstream-documented dummy `ollama` value.

## Pi E2E

The Pi E2E uses the local Codex CLI subscription auth file to seed an ignored Pi
`auth.json` under `.runtime/`.

These are live runs: they spend real tokens and require local engine auth
(`~/.codex/auth.json` for Pi/Codex; triad additionally needs
authenticated `grok` and `agy` CLIs on PATH). They are not part of `npm test`.

```bash
npm install
npm run e2e:pi-agent
npm run e2e:pi-memory-org
npm run e2e:jungian-play-org
npm run e2e:jungian-triad-org
```

The example starts two harnessed Pi agents from plain caller code. The example
creates the workspaces and shared resource itself to demonstrate the intended
boundary: the caller prepares files, the harness runs agent turns.

The memory-org example starts three harnessed Pi agents, gives each agent a
private marker memory, clears Pi session history, then runs a room-style recall
conversation. It restarts one agent again before the final check, so the final
answer must come from Daimon's persisted memory rather than Pi's live chat
session.

The mixed-engine example starts a small org backed by real local CLIs:
Navigator uses Codex, Cartographer uses Grok, and Sentinel uses Agy. Each engine
invents its own private signal, then the room conversation verifies that later
turns recall those LLM-generated signals through Daimon memory.

The Jungian play example starts two selves as characters in a play. Each self
has archetype voices such as Persona, Shadow, Anima/Animus, Wise One, Great
Mother, Hero, and Trickster. The inner voices run first, the representative self
then speaks externally, and the run writes play traces plus memory/latency
telemetry under `.runtime/jungian-play-org/`.

The Jungian triad example uses three complete Jungian selves in one
conversation: Maya speaks through Codex CLI, Leo speaks through Grok, and Priya
speaks through a Pi agent seeded from local Codex subscription auth. All three
selves carry the same full archetype set, rotated through the run so every
archetype gets consulted.

## Docs

Start with `docs/README.md` for the current documentation map:

- `docs/runtime.md` explains the organization-runtime config, control API,
  schedules, durable wake acceptance, and attention.
- `docs/engines.md` explains Pi and CLI engine boundaries.
- `docs/memory.md` explains Daimon's Mneme adapter.
- `docs/observability.md` explains causal events, raw capture, and world
  trajectories.

Historical migration plans and audits live under `archive/`.
