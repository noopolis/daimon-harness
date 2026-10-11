# Runtime

[Documentation index](README.md)

Daimon's organization runtime hosts isolated agents from one strict config. It
does not know team structure, org graphs, Moltnet room policy, deployment, or
Spawnfile compilation.

Use the package subpath:

```ts
import {
  createOrganizationRuntimeHost,
  parseOrganizationRuntimeConfig
} from "@noopolis/daimon/runtime";
```

The CLI entrypoint is:

```bash
daimon-runtime run --config /runtime/daimon-runtime.json
```

The config parser accepts `noopolis.daimon.organization-runtime.v1` and `v2`.
Both require a host and one to 32 agents. Each agent has:

- `id`, `name`, and `instructions`.
- absolute `workspacePath` and `runtimeHomePath`.
- `engine.kind` of `codex`, `grok`, or `agy`.
- optional `mcp`, `moltnet`, `memory`, `attention`, and `recording`.
- for v2 only, one `schedule`.

Configuration must not contain credentials, arbitrary environment maps, command
arrays for engines, process handles, roles, teams, or parent/member links. The
parser normalizes paths and rejects overlapping workspace/runtime-home roots.
Before starting agents, the host verifies caller-created directories are real,
current-user-owned, and not unsafe through symlinks or writable permissions.

The control token is named by `host.controlTokenEnv`; only the variable name is
stored in config. HTTP requests use `Authorization: Bearer <token>`.

## Task clock environment

Set `NOOPOLIS_TASK_CLOCK` before startup to consume the ecosystem task clock:

```json
{"version":"noopolis.task-clock.v1","origin":"2024-02-29T12:00:00+02:00","anchorEpochMs":1800000000000}
```

Task time advances as `Date.parse(origin) + (Date.now() - anchorEpochMs)`.
The origin must be a valid ISO-8601 instant with `Z` or an explicit offset;
the anchor must be a safe integer. Invalid JSON, missing or unknown fields,
wrong versions, invalid dates, offset-less origins and invalid anchors refuse
startup with a `NOOPOLIS_TASK_CLOCK` error. An empty value is invalid, not unset.
Unset preserves existing behavior.

This is an environment-only option shared by the organization runtime and the
standalone Pi harness. It adds no public config field or callback and no
compiler dependency. Keep the process environment fixed for the runtime's
lifetime; a different clock requires restarting it.

Daimon forwards the original JSON bytes to engine CLI and MCP stdio children,
Pi bash tools and Moltnet CLI children. It also derives `MNEME_CLOCK_ORIGIN`
and `MNEME_CLOCK_ANCHOR_MS` from that same origin and anchor. It never resets
the anchor when a process starts. Any conflicting server-declared value of
these three variables refuses startup, including declarations for remote MCP
servers; matching values are allowed. This prevents silent clock divergence.
Remote MCP services must be launched with the same contract by their owner;
Daimon cannot set another service's process environment.

In-process memory requires Mneme's root `createOffsetClock` export and
`createMemoryRuntime({ clock })` support. Daimon detects that export in one
adapter and passes its epoch-ms clock to the memory runtime. A configured
clock with an older Mneme refuses startup and names both required capabilities.
The dependency version is unchanged. Memory policy and storage remain Mneme's.

The current native Grok broker has a fixed worker environment without clock
propagation. Task-clock runs using that broker refuse startup explicitly;
they require a separate native broker contract/artifact update. Direct engine
CLI children receive the three variables through the normal CLI environment.

Daimon does not add ambient `FAKETIME`, `FAKETIME_DONT_FAKE_MONOTONIC` or
`LD_PRELOAD` forwarding to its positive CLI/MCP environment. Existing inherited
environments (Pi bash and Moltnet) keep their previous policy. The contract
does not patch `Date`, OS clocks or arbitrary executables: child processes
must consume it, and OS-level clock virtualization remains caller-owned.

| Time surface | Clock / treatment |
| --- | --- |
| Final wake prompt, including memory, world, dream and direct-memory example wakes (`piAgentHandle`, `prompts`, `jungianPlayAgent`) | Current advancing task time is prepended when configured. |
| Mneme prompts, memory tools, recall and storage | Mneme receives `clock`; Daimon does not rewrite memory data. |
| Native schedule occurrence shown in attention prompt / `daimon_inbox` (`organizationRuntimeControl`) | Convert the real occurrence to task time at delivery creation. |
| Incoming wake/inbox `occurred_at` | Producer-owned event time, preserved; producers must use the task clock for newly generated events. Never apply the offset twice. |
| Replayed `moltnet_send` receipt `at` (`productionAgentTools`) | Convert the stored real timestamp to task time for both model-visible result channels. |
| `moltnet_read`, external MCP results, world ticks | Historical/external payloads remain verbatim; clock-aware external tools own their current timestamps. |
| Schedule due times, sleeps, wake/CLI/MCP/world deadlines, auth expiry, claim leases, retention, fuses, latency | Real time, unchanged. Fuse epoch and delivery identifiers remain opaque identifiers. |
| Activity/health (`organizationRuntimeHost`, `piAgentHandle`), drain state (`organizationRuntimeControl`) | Real operational bookkeeping on control APIs. |
| Acceptance receipts/reconciliation (`wakeAcceptanceStore`, `wakeAcceptanceReconciliation`), tool receipts (`productionAgentTools`), schedule state (`schedule`), fuse admissions/trips (`wakeFuse`) | Real timestamps on disk; model-visible projections are classified above. |
| Usage/request/inference/seal ledgers (`turnUsageLedger`, `turnRequestLedger`, `inferenceUsageLedger`, `grokEngineBrokerLedger`, `engineBrokerSealLedger`); broker request timings (`grokBrokerTurnMeter`) | Real accounting and latency measurements. |
| Pi session event timestamps (`cliSession`), turn traces (`turnTrace`), raw training captures (`rawTrainingCapture`), world trajectories (`worldTrajectory`), causal telemetry (`causalEvents`) | Real diagnostic bookkeeping, unchanged. |

Runtime endpoints:

- `GET /healthz` is unauthenticated process health.
- `POST /v1/wake` runs one synchronous wake for non-attention agents.
- `GET /v1/health` returns host and agent health.
- `GET /v1/activity` returns bounded activity.

Set `DAIMON_RUNTIME_ACCEPTANCE_STORE` to enable the durable v2 control plane:

- `POST /v2/wakes` fsyncs an accepted wake before execution.
- `GET /v2/wake-receipts/<acceptance_id>` returns redacted lifecycle status.
- `GET /v2/activity` includes durable receipts and active executions.
- `GET /v2/availability` reports running, pending, deferred, and budget state.
- `POST /v2/drain` stops admitting turns until `POST /v2/resume`; both answer
  the availability document.

A drain is the reversible operator stop. New wakes answer HTTP 409 with the
existing `work-blocked` descriptor (reason `operator_stop`, so current bridges
defer and retry), queued deliveries stay accepted, and a running turn finishes.
Availability then reports `state: "paused"` and `drain: {state, since}`:
`draining` while a turn may still run, `drained` once nothing can start. Resume
dispatches the queue. A drain lives in the process: a restarted host admits.
It never clears the latched `fuse.stop`, which stays the deliberate safety stop.

Equal delivery retries return the original acceptance. A changed payload for the
same delivery id is rejected. Accepted delivery is durable at-least-once turn
delivery; destinations that require exactly-once effects must deduplicate their
own external side effects.

Attention is opt-in per agent:

```json
{
  "attention": {
    "maxBatchMessages": 8,
    "maxBatchBytes": 12000,
    "maxExecutions": 30,
    "maxTokens": 3000000
  }
}
```

Attention agents require the durable v2 route. They receive `daimon_inbox` and
`daimon_inbox_disposition`; reading does not complete a message, and unmarked
or deferred deliveries stay pending. The generated execution prompt must fit
both the 4,096-codepoint and 16,384-byte runtime limits, including the inbox
wrapper. Larger selected payloads remain intact in `daimon_inbox`; the prompt
instructs the agent to read them there.

Rejected or failed executions also leave unfinished deliveries pending, but
persist a bounded, credential-redacted diagnostic. `GET /v2/availability`
reports that agent's `error` and a `paused` aggregate state, even after restart
or successful work on a different delivery. The diagnostic clears when that
delivery is successfully handled or explicitly deferred by the agent. Retry
still requires new external input; failures do not create a self-wake loop.

The diagnostic is an optional private `execution_error` field in the stored
receipt. Public receipt schemas are unchanged. Older runtimes cannot read a
store containing that field; retain the newer runtime when recovering it.

Wake recording is opt-in per agent in either config version. The durable
inbox dispatcher records after claim/admission and before calling the host:

```json
{
  "recording": {
    "directory": "/recordings/writer",
    "keepMs": 2592000000,
    "snapshots": [{ "id": "edition-state", "path": "/shared/edition-state" }]
  }
}
```

All three members are required and extra keys are refused. `keepMs` is a positive
safe integer. `snapshots` has 0–16 roots with unique ids matching
`^[A-Za-z0-9._-]{1,128}$` and unique absolute POSIX paths. Paths normalize exactly
as the existing runtime roots do. A recording store cannot overlap any snapshot,
workspace, runtime home, or peer recording store. Snapshot sources may be shared.
The caller creates the store, owned by the runtime user with mode `0700`, without
symlink components. Sources need read/search access, not runtime ownership or
private permissions; a missing source is an empty snapshot with a `root_missing`
note. Omitting `recording` performs no recording filesystem operations.

The data-only contract manifest's `wakeMoments` section advertises this capability;
its digest participates in the image capability receipt. The store contains:

```text
<directory>/
  wake-moments.jsonl
  snapshots/<root id>/
    latest
    <compact started_at>-<execution id>/
    <compact started_at>-<execution id>.manifest.json
    <compact started_at>-<execution id>.complete
```

`started_at` is the ISO millisecond UTC time capture begins. Rows identify the
agent and execution and list delivery acceptance id, delivery id, kind and
occurrence time, plus successful roots' `id`, `snapshot`, `files`, `copied`,
`linked`, and `skipped` counts. No delivery text is recorded. The execution id
matches active execution reporting: the first delivery id without attention,
the batch execution id with attention. Every recovery attempt appends another
row; consumers take the last attempt whose snapshot completed before the turn.
An agent with `recording` accepts only durable inbox wakes (`POST /v2/wakes`).
Synchronous `/v1/wake` and direct legacy host calls return the existing
`rejected` result with code `durable_inbox_required`, before queuing any turn.
Agents without recording retain their existing admission behavior.

Filesystem encoding preserves ordinary identifiers. The reserved root ids `.`
and `..` use `%2E` and `%2E%2E` directory names. Execution ids outside
`[A-Za-z0-9._-]{1,128}` use `sha256-<hex digest>` in filenames; rows retain the
original id. Same-time/id collisions get a UUID suffix, never overwrite an
attempt. Collision checks include directories, partials, manifests, completion
markers, and temporary files. Cleanup owns a path only after successful exclusive
creation; publication reserves its destination exclusively too. The row's
`snapshot` is the authoritative directory name.

Each manifest maps relative paths to type, mode, size, source identity and
symlink target. Large stat values are decimal strings. Unchanged regular files
are hard-linked from the previous complete snapshot using the **source**
`dev`, `ino`, `size`, `mtimeNs`, `ctimeNs`, and `mode` (bigint stats); all other
regular files are copied. Directories are recreated privately (`0700`), with
original modes in the manifest for replay. Symlinks are recreated, never read
through; sockets, FIFOs and devices are skipped and counted. A root exceeding
200,000 entries (including directories, links and skipped entries) fails that
capture. A manifest is limited to 128 MiB of serialized UTF-8, shared by
reader and writer; an oversized root fails with `manifest_size_limit` before
either directory or manifest publication. Each JSONL line is capped at 4 MiB, including its newline; retention
reads enforce the same bound. Errors contain bounded reason codes, never source
paths, file contents or arbitrary exception text.

Source directory opens compare descriptor `dev`/`ino` with the preceding lstat.
Linux walks through `/proc/self/fd`; other platforms use pathnames with directory
identity checks around entry lookup, before file reads, and after enumeration.
Files open with `O_NOFOLLOW` and must match the entry's lstat identity. A detected
directory replacement aborts that root with an error instead of publishing it.

A root builds in `<snapshot>.partial`: copied files and directories are synced,
the directory is renamed and synced, then its manifest is written by synced
temporary file and rename. A snapshot is complete only with both directory and
manifest and its regular, zero-byte, single-link `.complete` ownership marker,
synced last. Ineligible markers are ignored before choosing a link base or the
protected newest snapshot; their candidates are never pruned. The row follows in one append write plus fsync (and a directory fsync
on first creation). Root failure removes the partial, omits that root from the
row, records an error, and lets the turn run. Row or retention failure is logged
and also lets the turn run. A torn final row is delimited before a later append;
readers must ignore invalid lines.

Capture has a fixed 60-second deadline (`wakeMoments.captureDeadlineMs`), shared
across all roots and initial store validation. A timer and cancellation checks
between filesystem operations stop abandoned capture work from issuing further
writes. On expiry, unfinished roots are omitted and the row reports
`capture_deadline_exceeded`. Cleanup, the row attempt, and retention have a
separate fixed one-second finalization budget (`finalizationDeadlineMs`); a
stalled cleanup does not prevent attempting the error row. The dispatcher and
shutdown never await the abandoned capture promise. Healthy storage records the
error before the turn; if even row I/O stalls or the store is untrustworthy,
Daimon logs a bounded reason and runs the turn. Node cannot cancel a syscall
already in flight; it can still finish, and late opens are closed. Recursive
cleanup checks cancellation between individual filesystem operations. Timers
also depend on event-loop scheduling; these are not real-time OS deadlines.
Neither deadline is caller-configurable.

The recording root stays pinned to its validated `dev`, `ino`, `uid`, and mode.
Existing path-authority checks reverify its identity and absence of symlink
components immediately before capture, publication, and deletion (and before
writes). Startup authority is checked again when available. A mismatch stops
recording for that wake; an error row is attempted only through a still-trusted
store, otherwise the failure is logged. Node has no `openat`: as with spill
publication, a residual lstat-then-act race remains between verification and a
path-based syscall. This is detection, not race-free descriptor-relative I/O.

After append, retention removes rows and complete snapshots older than
`now - keepMs`, always retaining the newest complete snapshot for every root
(including removed roots), **plus the just-appended attempt and every snapshot
it references**, independently of `keepMs` or clock movement. Snapshot ages come
from their names. The completion marker proves writer ownership without reading
historical manifests; only the newest link-base manifest per root is read during
capture. Each root's `latest` is a bounded (1 KiB) durable cache naming the newest
snapshot and the oldest retained non-newest snapshot. Reads validate its shape
and the newest candidate's eligibility, enumerating history only if the cache is
missing/invalid. A capture writes the cache via exclusive tmp, fsync, rename and
directory fsync **before** creating the completion marker: an interrupted newer
capture leaves an invalid pointer that forces recovery, never a stale valid
pointer hiding a newer complete capture. Clock rollback preserves the newer base.
Retention enumerates history only when that tracked oldest name could expire or
the pointer needs recovery, then refreshes the oldest name. Ordinary wakes process
no snapshot-history entries; recovery and expiry sweeps still scale with history.
This assumes the runtime is the only snapshot publisher in its private store.
Ledger
compaction reads only its bounded first line on ordinary wakes, scanning fully
when that row is expired or once every 64 wakes (to handle a foreign prefix or
clock rollback); it renames a synced replacement only when rows were pruned.
Foreign files and unmarked directory/manifest pairs are untouched. The marker
is additive on-disk metadata: pre-marker pairs are preserved for inspection,
not reused or pruned automatically. Interrupted partials, orphan directories,
and temporary files can remain when best-effort cleanup cannot finish; a crash
can also leave rows referencing an expired snapshot during pruning. A crash
after snapshot completion but before row append can leave an unreferenced
complete snapshot. A crash after row append but before host invocation can
leave a row for a turn that never ran. Recording is evidence of the pre-turn
capture, not proof of execution.

The snapshot is a point-in-time copy taken while this agent is idle. Files are
copied without locks: concurrent writers to a **shared** root, including another
agent or a long-lived MCP server, can tear a file mid-copy or mix states across
files. Detected changes during copying fail that root, but this is not an atomic
filesystem snapshot. Completed snapshot files must be treated as immutable;
editing a hard-linked file changes every snapshot sharing that inode.

Version 2 schedules are normalized on the agent:

- `{ "kind": "disabled" }`
- `{ "kind": "every", "interval_ms": 60000, "prompt": "..." }`
- `{ "kind": "cron", "cron": "0 9 * * 1", "timezone": "Europe/Berlin", "prompt": "..." }`

Optional `jitter_seconds` is bounded to one hour. Schedules are runtime-native
delivery sources; they do not give Daimon org-graph authority.

`reconcileOfflineWakeTransition` is a library operation for deployment-admin
recovery of a blocked durable store. It is not an HTTP endpoint or normal host
action.
