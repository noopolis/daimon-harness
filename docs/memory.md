# Memory

[Documentation index](README.md)

Daimon adapts Mneme into agent turns; it does not own memory storage, policy,
recall, redaction, or MCP. Those semantics live in `@noopolis/mneme`.

For Pi agents, enable memory on `PiHarnessAdapter`:

```ts
import { PiHarnessAdapter } from "@noopolis/daimon/pi";

const adapter = new PiHarnessAdapter({
  authPath: "/runtime/pi-auth/auth.json",
  memory: {
    runtimeHomePath: "/runtime/memory/writer",
    source: "daimon",
    tokenBudget: 20000
  }
});
```

If `memory.runtimeHomePath` is omitted, the adapter uses the agent's
`runtimeHomePath`. Supplying an explicit memory runtime home lets several Pi
or CLI sessions share one Mneme bank while keeping their engine homes separate.

Per turn, Daimon asks Mneme to prepare the memory context and then exposes only
Mneme's model-facing tools for the active trusted context. The context is
checked against:

- the current agent id;
- the Mneme authority bank id;
- the active principal scope;
- a bounded set of canonical allowed scopes.

Tool arguments are validated against Mneme's tool schemas before execution.
Unexpected top-level fields are rejected.

Awake wakes use normal working memory behavior. Dream wakes use a fresh
one-off session under `sessions/dream/<wake-id>-<random>` and prepend dream
guidance for consolidation work.

Daimon does not automatically write every turn into memory. Agents persist
memory only by calling Mneme tools such as `memory_register`,
`memory_summarize`, and `memory_forget`.

Organization-runtime config can declare memory per agent:

```json
{
  "memory": {
    "runtimeHomePath": "/runtime/memory/writer",
    "source": "daimon",
    "tokenBudget": 20000
  }
}
```

In production CLI engines, the runtime passes this memory config into the same
Pi harness layer that mounts production tools. The memory runtime remains
in-process for Daimon; other runtimes can use Mneme through its own MCP server.

### Scheduled dreams

A v2 agent can give its memory bank a second schedule. This example requests
a daily review at 03:00 UTC.

```json
{
  "memory": {
    "runtimeHomePath": "/runtime/memory/writer",
    "dreamSchedule": {
      "kind": "cron",
      "cron": "0 3 * * *",
      "timezone": "UTC",
      "prompt": "Review the bank and consolidate memories supported by evidence."
    }
  }
}
```

An interval uses the same `kind: "every"` and `interval_ms` fields as a work
schedule. The durable control host queues each occurrence for the agent.
Each dream opens a fresh session on the configured bank. The next ordinary
turn uses the agent's awake session. Omit `dreamSchedule` to leave maintenance
off. The agent's top-level `schedule` independently controls ordinary work.
