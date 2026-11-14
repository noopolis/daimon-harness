# Pi runtime implementation

This directory owns the Pi harness and native CLI adaptation. Keep public
runtime contracts independent of Pi types. Files stay below 400 lines and
tests live beside their implementations.

Engine processes stay on real time. Direct engines and clocked broker worker
configs share `shellEnvironmentPolicyEntries` so filters/secret exclusions agree.
Broker clock-gap reporting belongs after worker config attestation; the client
sends only the relative `processClock` derived by Daimon's existing helper.

Codex permission rendering must preserve the effective path permissions while
removing redundant nested denies that cannot be mounted by its Linux sandbox.
An intervening readable path or workspace root makes a deeper deny necessary.
Verify changes with generated production arguments and real local sandbox
commands; a model call is neither required nor permitted for this check.

The per-wake MCP mount is torn down on the wake's own completion path, so that
teardown must be bounded. `Server.close()` waits for every open connection, and
a connection the MCP transport has no record of — a socket opened before
`initialize`, or an idle keep-alive socket a client's pool still holds, which is
what relaying a turn through the broker MCP facade leaves behind — is not the
transport's to end. Close the transport first, then end the remaining
connections; never wait for the client to release them. A finished turn that
parks here publishes nothing and dies to an outer deadline, which loses exactly
the terminal evidence the turn existed to produce.

A CLI engine child's whole stderr is forwarded to the runtime's own stderr as it
arrives (`cliStderrLog.ts`): every line, credentials redacted, prefixed
`daimon: engine stderr engine=<kind> wake=<id> |`. The wake's error still
carries only the bounded head and tail (`CLI_ENGINE_MAX_DIAGNOSTIC_BYTES`); the
runtime log is the full account, kept by whoever keeps the container's log.
Stdout is the engine's transcript and stays in the engine's own home.

The per-wake MCP mount (`cliSessionMcp.ts`) serves any number of client
sessions, each with its own server and transport over the same tools and one
shared tool-turn count. AGY 1.1.22 opens one session to write the tool schemas
and another for the conversation that calls them; a single-session transport
refused the second `initialize`, so the model was told its tools by name and
given none. Sessions are bounded by `MAX_MCP_SESSIONS`.

A CLI engine's whole stdout is kept per wake in the agent's runtime home
(`cliStdoutRecord.ts`, `ENGINE_OUTPUT_RECORD_DIRECTORY`): credentials redacted,
the newest `ENGINE_OUTPUT_RECORDS_KEPT` wakes, each bounded. It is advisory and
never fails a turn. The descriptors declare the directory in
`diagnostics.paths`.
