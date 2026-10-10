# Engines

[Documentation index](README.md)

Daimon has two layers:

- The runtime-neutral harness contract in `src/core`.
- Engine adapters under `src/pi` and `src/runtime`.

The simple one-agent contract is:

```ts
import type { AgentHarnessAdapter, WakeEvent } from "@noopolis/daimon";
```

`AgentHarnessAdapter.startAgent()` receives one agent's id, name,
instructions, workspace path, runtime home, and optional tool names. The
returned handle accepts one `WakeEvent` at a time and returns text, duration,
and status.

An isolated host can supply `AgentStartInput.causalRunId`. This trusted value is
fixed for the agent instance and used by its wake acceptance and causal turn
records; it is never taken from a wake body or model output. Omitting it keeps
the existing `NOOPOLIS_RUN_ID` environment behavior. Explicit context with
configured Mneme memory currently fails before startup because Mneme's public
runtime does not yet accept per-instance causal context. Check
`PiHarnessAdapter.capabilities.causalRunId` before relying on this integration.

## Pi

`@noopolis/daimon/pi` exports `PiHarnessAdapter` and helpers for Pi auth,
models, world tools, and traces:

```ts
import { PiHarnessAdapter } from "@noopolis/daimon/pi";
```

The Pi adapter creates the runtime-home subdirectories it needs, creates the
workspace if absent, resolves a Pi model, mounts optional Mneme and world tools,
and creates awake or dream sessions. Caller instructions are included in the
system prompt; SOUL or identity-like standing instructions belong in the
agent's `instructions` field supplied by the caller.

Model intents support built-in Pi providers and explicit OpenAI-compatible or
Anthropic-compatible endpoints. Endpoint auth is limited to `none` or
`api_key`; Codex and Claude subscription helpers write Pi auth storage instead.

Auth helpers:

- `seedPiOpenAICodexAuthFromCodex`
- `seedPiAnthropicAuthFromClaudeCode`
- `seedPiApiKeyAuth`
- `createPiOpenAICodexAuthFromCodexToken`

## CLI Engines

The organization runtime accepts `codex`, `grok`, and `agy` engine intents. It
does not accept arbitrary commands or environment maps in config.

At startup and before each wake, Daimon resolves the executable from a safe
`PATH`, pins its file identity, probes `--version`, and verifies the selected
auth boundary.

Codex uses a private `.codex/auth.json` under each agent runtime home. Optional
Codex config fields are `model`, `reasoningEffort`, and the fixed no-network
workspace sandbox policy.

Every Codex wake enables and requires Daimon's per-wake MCP server, including
standalone and strict sandbox launches. If the server cannot initialize, Codex
fails the wake before model work instead of continuing with only built-in tools.
The startup error follows the existing bounded, redacted engine failure path.

Daimon also disables Codex subscription apps and installed plugins on every
wake with `features.apps=false` and `features.plugins=false`. This keeps ambient
account tools out of discovery while preserving the declared per-wake MCP
tools and built-in coding tools. These settings are invocation arguments;
changing an engine home's config does not affect a strict launch that ignores
user configuration. Caller `--enable` arguments are rejected because Codex
applies them after ordinary config overrides.

Codex may still defer declared tools behind `tool_search`. Server startup and
tool discovery are separate checks; `list_mcp_resources` does not list tools.
Codex 0.142.3 accepts the two isolation settings above, but its former
`tool_search` feature toggle is a removed no-op and cannot disable discovery.

Public `createCliSessionFactory` callers running isolated experiments can select
`codexProjectDocMaxBytes: 0` with the strict `codexSandbox` policy. This disables
Codex's implicit instruction-file discovery so the host can supply its exact
`identityPrompt` without ambient project/home instructions. A nonzero value or
use without strict policy is rejected. Existing production defaults are unchanged.

The production Grok path uses an external Daimon engine broker with one durable
subscription credential authority. Agent workers receive scoped capabilities;
the broker owns refresh and stale-credential recovery. The runtime checks broker
readiness before admitting Grok agents and verifies their sandbox policy before
turns. The older credential-lease helper is not the production host path.

The broker worker is pinned to Grok CLI 1.0.34 and runs lean: a fixed Daimon
system prompt, six tools (`run_terminal_command`, `read_file`, `grep`,
`list_dir`, and the MCP meta-tools `search_tool`/`use_tool`), no bundled
skills, workflows, plan mode, subagents, memory or web search, and a declared
model and reasoning effort from a closed list (default `grok-4.6` at `low`).
The broker proxy refuses any request outside that shape before it spends.

Each broker registration (`service.json` v2) declares its model and effort,
its usage ledger, and turn limits `{maxRequests, maxTokens, timeoutMs}`. A wake
may only lower them (`DAIMON_ENGINE_WAKE_TIMEOUT_MS`,
`DAIMON_ENGINE_WAKE_TOKEN_CEILING`; the `DAIMON_CODEX_WAKE_*` names are
aliases). The proxy refuses request `maxRequests + 1` and any request after the
deadline with HTTP 429 before upstream, and stops admitting requests once the
upstream-reported running total (cached input included) reaches `maxTokens`, so
a turn overshoots its token ceiling by at most one request. A tripped limit
kills the worker. The broker seals every terminal turn with its usage, request
count, declared model and limit reason, and writes one usage row (keyed by
`turn`) plus per-request rows for completed and failed turns alike; a replayed
turn is never metered twice. `resolveOrganizationGrokBrokerProjection` exposes
a slot's full declared shape, and `noopolis.daimon.grok-slot-preflight.v2`
receipts bind a slot's denied-path canaries to that projection's digest and to
one recycle (the caller's nonce and the slot's increasing generation).

Evaluators (Paideia judges and the optimizer, organization uid only) borrow the
same credential through inference grants: `request_inference_grant` over the
control socket returns a ten-minute token for one declared model and effort,
which the evaluator's Grok CLI presents to the provider proxy through
`env_key` in a config rendered by `renderGrokInferenceClientConfig`. Grant
requests must carry no tools, are metered like a turn, and are written only to
the broker's separate `inferenceLedgerPath` (`kind: "inference"` rows), never
to a subject usage ledger or the wake fuse.

AGY uses OS-native secure storage through one private D-Bus and Secret Service
realm. Enroll it once with:

```bash
daimon-runtime auth agy login --config /runtime/daimon-runtime.json
```

Daimon does not accept portable AGY token files, API keys, ADC credentials, or
ambient D-Bus sessions.

## Live Checks

`npm test`, `npm run typecheck`, and `npm run build` do not call model
providers.

Live scripts and examples spend real tokens and require local subscription
auth:

- `npm run live:grok-broker`
- `npm run e2e:pi-agent`
- `npm run e2e:pi-memory-org`
- `npm run e2e:jungian-play-org`
- `npm run e2e:jungian-triad-org`
