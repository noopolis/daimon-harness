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
attempt. The row's `snapshot` is the authoritative directory name.

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

A root builds in `<snapshot>.partial`: copied files and directories are synced,
the directory is renamed and synced, then its manifest is written by synced
temporary file and rename. A snapshot is complete only with both directory and
manifest and its zero-byte `.complete` ownership marker, synced last. The row follows in one append write plus fsync (and a directory fsync
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
capture. Directory-name enumeration still scales with snapshot count. Ledger
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
