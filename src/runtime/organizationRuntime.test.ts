import { strict as assert } from "node:assert";
import test from "node:test";

import {
  ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS,
  ORGANIZATION_RUNTIME_CONFIG_SCHEMA,
  ORGANIZATION_RUNTIME_MAX_AGENTS,
  ORGANIZATION_RUNTIME_MAX_STRING_BYTES,
  ORGANIZATION_RUNTIME_VERSION,
  validateOrganizationRuntimeConfig,
  parseOrganizationRuntimeConfig,
  parseOrganizationRuntimeWakeRequest
} from "./organizationRuntime.js";
import type { OrganizationRuntimeEngineIntent } from "./organizationRuntime.js";

const valid = () => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_CONTROL_TOKEN" },
  agents: [{
    id: "editor",
    name: "Editor",
    instructions: "Write a concise report.",
    workspacePath: "/runtime/workspaces/editor",
    runtimeHomePath: "/runtime/homes/editor",
    engine: { kind: "codex" } as OrganizationRuntimeEngineIntent
  }]
});

test("parses the strict flat v1 contract", () => {
  const parsed = parseOrganizationRuntimeConfig(valid());
  assert.equal(parsed.version, ORGANIZATION_RUNTIME_VERSION);
  assert.equal(parsed.agents[0]?.engine.kind, "codex");
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.additionalProperties, false);
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.minItems, 1);
});

test("semantic validator and parser share a conformance corpus", () => {
  const cases: readonly [unknown, boolean][] = [
    [valid(), true],
    [{ ...valid(), agents: [] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], id: " " }] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], workspacePath: "/work/../escape" }] }, true],
    [{ ...valid(), agents: [{ ...valid().agents[0], runtimeHomePath: "/home//agent" }] }, true],
    [{ ...valid(), agents: [{ ...valid().agents[0], engine: { kind: "pi" } }] }, false],
    [{ ...valid(), agents: [{ ...valid().agents[0], engine: { kind: "scripted", protocol: "noopolis.daimon.scripted.v1", programPath: "agent.mjs" } }] }, false],
    [{ ...valid(), agents: [valid().agents[0], { ...valid().agents[0] }] }, false]
  ];
  for (const [candidate, accepted] of cases) {
    assert.equal(validateOrganizationRuntimeConfig(candidate), accepted);
    assert.equal(accepted, (() => { try { parseOrganizationRuntimeConfig(candidate); return true; } catch { return false; } })());
  }
});

test("rejects sparse agent arrays", () => {
  const sparse = valid();
  sparse.agents = new Array(1) as typeof sparse.agents;
  assert.throws(() => parseOrganizationRuntimeConfig(sparse), /present record/);
  const mixed = valid();
  mixed.agents = [{ ...mixed.agents[0]! }, , { ...mixed.agents[0]!, id: "other" }] as typeof mixed.agents;
  assert.throws(() => parseOrganizationRuntimeConfig(mixed), /present record/);
});

test("bounds programmatic config size, agents, and every string field", () => {
  const tooMany = valid();
  tooMany.agents = Array.from({ length: ORGANIZATION_RUNTIME_MAX_AGENTS + 1 }, (_, index) => ({
    ...valid().agents[0]!, id: `agent-${index}`
  }));
  assert.throws(() => parseOrganizationRuntimeConfig(tooMany), /between 1 and/);
  const tooLong = valid();
  tooLong.agents[0]!.instructions = "x".repeat(ORGANIZATION_RUNTIME_MAX_STRING_BYTES + 1);
  assert.throws(() => parseOrganizationRuntimeConfig(tooLong), /string limit/);
  assert.equal(ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.maxItems, ORGANIZATION_RUNTIME_MAX_AGENTS);
});

test("rejects unknown versions and organization semantics before any side effect", () => {
  const unknownVersion = valid();
  unknownVersion.version = "noopolis.daimon.organization-runtime.v3" as typeof ORGANIZATION_RUNTIME_VERSION;
  assert.throws(() => parseOrganizationRuntimeConfig(unknownVersion), /config.version/);
  for (const forbidden of ["teams", "roles", "parents", "members", "edges", "schedules", "wakePolicy", "deployment", "moltnet"]) {
    const config = valid() as Record<string, unknown>;
    config[forbidden] = [];
    assert.throws(() => parseOrganizationRuntimeConfig(config), /exactly/);
  }
});

test("v2 cron schedules reject out-of-range and unsupported syntax", () => {
  for (const cron of ["60 0 * * *", "0 24 * * *", "0 0 0 * *", "0 0 32 * *", "0 0 * 0 *", "0 0 * 13 *", "0 0 * * 8", "5-1 * * * *", "*/0 * * * *", "L * * * *"]) {
    const source = valid();
    const config = { ...source, version: "noopolis.daimon.organization-runtime.v2", agents: [{ ...source.agents[0], schedule: { kind: "cron", cron, timezone: "UTC", prompt: "work" } }] };
    assert.throws(() => parseOrganizationRuntimeConfig(config), /cron is invalid/);
  }
});

test("v2 schedules reject impossible cron, oversized prompt, and out-of-range cadence", () => {
  const source = valid();
  const scheduled = (schedule: unknown) => ({ ...source, version: "noopolis.daimon.organization-runtime.v2", agents: [{ ...source.agents[0], schedule }] });
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "cron", cron: "0 0 31 2 *", timezone: "UTC", prompt: "work" })), /impossible/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 31_536_000_001, prompt: "work" })), /outside its bound/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 1, prompt: "x".repeat(4_097) })), /string limit/);
  assert.equal(parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 31_536_000_000, prompt: "work" })).version, "noopolis.daimon.organization-runtime.v2");
});

test("v2 schedules accept jitter_seconds within bounds and reject out-of-range or malformed values", () => {
  const source = valid();
  const scheduled = (schedule: unknown) => ({ ...source, version: "noopolis.daimon.organization-runtime.v2", agents: [{ ...source.agents[0], schedule }] });
  const cronOk = parseOrganizationRuntimeConfig(scheduled({ kind: "cron", cron: "0 10 * * *", timezone: "Europe/Berlin", prompt: "work", jitter_seconds: 900 }));
  assert.equal(cronOk.agents[0]?.schedule?.kind === "cron" ? cronOk.agents[0].schedule.jitter_seconds : undefined, 900);
  const everyOk = parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 60_000, prompt: "work", jitter_seconds: 0 }));
  assert.equal(everyOk.agents[0]?.schedule?.kind === "every" ? everyOk.agents[0].schedule.jitter_seconds : undefined, 0);
  const noJitter = parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 60_000, prompt: "work" }));
  assert.equal(noJitter.agents[0]?.schedule?.kind === "every" ? noJitter.agents[0].schedule.jitter_seconds : undefined, undefined);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "cron", cron: "0 10 * * *", timezone: "UTC", prompt: "work", jitter_seconds: 3_601 })), /jitter_seconds is outside its bound/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "cron", cron: "0 10 * * *", timezone: "UTC", prompt: "work", jitter_seconds: -1 })), /jitter_seconds is outside its bound/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "cron", cron: "0 10 * * *", timezone: "UTC", prompt: "work", jitter_seconds: 1.5 })), /jitter_seconds is outside its bound/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "every", interval_ms: 60_000, prompt: "work", jitter_seconds: "900" })), /jitter_seconds is outside its bound/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled({ kind: "disabled", jitter_seconds: 900 })), /exactly kind/);
});

test("v2 cron schedules normalize whitespace and reject unbounded steps and text", () => {
  const source = valid();
  const scheduled = (cron: string) => ({ ...source, version: "noopolis.daimon.organization-runtime.v2", agents: [{ ...source.agents[0], schedule: { kind: "cron", cron, timezone: "UTC", prompt: "work" } }] });
  const parsed = parseOrganizationRuntimeConfig(scheduled("  0   5  *  *   *  "));
  assert.equal(parsed.agents[0]?.schedule?.kind === "cron" ? parsed.agents[0].schedule.cron : undefined, "0 5 * * *");
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled(`*/${"9".repeat(400)} * * * *`)), /invalid/);
  assert.throws(() => parseOrganizationRuntimeConfig(scheduled("*".repeat(4_097))), /string limit/);
});

test("rejects unsafe auth names, duplicate ids, and invalid absolute paths", () => {
  const unsafe = valid();
  unsafe.host.controlTokenEnv = "TOKEN; rm";
  assert.throws(() => parseOrganizationRuntimeConfig(unsafe), /safe environment/);
  const duplicate = valid();
  duplicate.agents.push({ ...duplicate.agents[0]!, id: "editor" });
  assert.throws(() => parseOrganizationRuntimeConfig(duplicate), /duplicate id/);
  const relative = valid();
  relative.agents[0]!.workspacePath = "workspaces/editor";
  assert.throws(() => parseOrganizationRuntimeConfig(relative), /absolute POSIX/);
});

test("rejects inherited records and every lexical agent-path collision", () => {
  const inherited = Object.create({ version: ORGANIZATION_RUNTIME_VERSION, host: valid().host, agents: valid().agents });
  assert.throws(() => parseOrganizationRuntimeConfig(inherited), /plain own-properties/);
  const missingOwn = { version: ORGANIZATION_RUNTIME_VERSION, host: Object.create(valid().host), agents: valid().agents };
  assert.throws(() => parseOrganizationRuntimeConfig(missingOwn), /plain own-properties|exactly/);
  for (const [workspacePath, runtimeHomePath] of [
    ["/runtime/workspaces/editor", "/runtime/workspaces/editor"],
    ["/runtime/workspaces", "/runtime/workspaces/editor"],
    ["/runtime/homes/other", "/runtime/homes"]
  ]) {
    const config = valid();
    config.agents.push({ ...config.agents[0]!, id: "other", workspacePath, runtimeHomePath });
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
});

test("rejects same-agent overlap and filesystem-root capabilities", () => {
  for (const [workspacePath, runtimeHomePath] of [
    ["/runtime/agent", "/runtime/agent"],
    ["/runtime/agent", "/runtime/agent/home"],
    ["/runtime/agent/workspace", "/runtime/agent"]
  ]) {
    const config = valid();
    config.agents[0]!.workspacePath = workspacePath;
    config.agents[0]!.runtimeHomePath = runtimeHomePath;
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
  for (const key of ["workspacePath", "runtimeHomePath"] as const) {
    const config = valid();
    config.agents[0]![key] = "/";
    assert.throws(() => parseOrganizationRuntimeConfig(config), /filesystem root/);
  }
});

test("strict config and wake parsers never invoke getters or accept hidden keys", () => {
  let reads = 0;
  const hostile = valid() as Record<string, unknown>;
  Object.defineProperty(hostile, "version", { enumerable: true, get() { reads += 1; return ORGANIZATION_RUNTIME_VERSION; } });
  assert.throws(() => parseOrganizationRuntimeConfig(hostile), /enumerable data property/);
  assert.equal(reads, 0);

  const hidden = valid() as Record<string, unknown>;
  Object.defineProperty(hidden, "argv", { enumerable: false, value: ["--unsafe"] });
  assert.throws(() => parseOrganizationRuntimeConfig(hidden), /enumerable data property/);
  const symbols = valid() as Record<PropertyKey, unknown>;
  symbols[Symbol("argv")] = ["--unsafe"];
  assert.throws(() => parseOrganizationRuntimeConfig(symbols), /symbol properties/);

  const wake = { token: "token", agentId: "agent", event: {
    version: "noopolis.daimon.wake.v1", id: "wake", kind: "manual", text: "go", occurredAt: "2026-08-17T12:00:00.000Z"
  } } as Record<string, unknown>;
  Object.defineProperty(wake, "agentId", { enumerable: true, get() { reads += 1; return "agent"; } });
  assert.throws(() => parseOrganizationRuntimeWakeRequest(wake), /enumerable data property/);
  assert.equal(reads, 0);
});

test("canonicalizes POSIX absolute paths before storing and comparing isolation", () => {
  const canonical = valid();
  canonical.agents[0]!.workspacePath = "/runtime/./workspaces/editor/";
  canonical.agents[0]!.runtimeHomePath = "/runtime/homes/../homes/editor//";
  const parsed = parseOrganizationRuntimeConfig(canonical);
  assert.equal(parsed.agents[0]?.workspacePath, "/runtime/workspaces/editor");
  assert.equal(parsed.agents[0]?.runtimeHomePath, "/runtime/homes/editor");
  for (const [firstWorkspacePath, secondWorkspacePath] of [
    ["/runtime/shared/", "/runtime/shared/child"],
    ["/", "/runtime/child"],
    ["/runtime/a/../shared", "/runtime/shared/child/./leaf"]
  ]) {
    const config = valid();
    config.agents[0]!.workspacePath = firstWorkspacePath;
    config.agents[0]!.runtimeHomePath = "/runtime/homes/first";
    config.agents.push({ ...config.agents[0]!, id: "other", workspacePath: secondWorkspacePath, runtimeHomePath: "/runtime/homes/second" });
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
  const windowsSeparators = valid();
  windowsSeparators.agents[0]!.workspacePath = "\\runtime\\workspace";
  assert.throws(() => parseOrganizationRuntimeConfig(windowsSeparators), /POSIX/);
});

test("accepts only Daimon's three production engines", () => {
  for (const kind of ["codex", "grok", "agy"] as const) {
    const candidate = valid();
    candidate.agents[0]!.engine = { kind };
    assert.equal(parseOrganizationRuntimeConfig(candidate).agents[0]?.engine.kind, kind);
  }
  const injected = valid();
  injected.agents[0]!.engine = { kind: "codex", argv: ["--unsafe"] } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(injected), /exactly/);
});

test("accepts an optional codex model and reasoningEffort", () => {
  const withModel = valid();
  withModel.agents[0]!.engine = { kind: "codex", model: "gpt-5-codex" } as never;
  assert.equal(parseOrganizationRuntimeConfig(withModel).agents[0]?.engine.model, "gpt-5-codex");

  const withEffort = valid();
  withEffort.agents[0]!.engine = { kind: "codex", model: "gpt-5-codex", reasoningEffort: "xhigh" } as never;
  const parsedEffort = parseOrganizationRuntimeConfig(withEffort).agents[0]?.engine;
  assert.equal(parsedEffort?.model, "gpt-5-codex");
  assert.equal(parsedEffort?.reasoningEffort, "xhigh");

  const omitted = valid();
  assert.equal(parseOrganizationRuntimeConfig(omitted).agents[0]?.engine.model, undefined);
  assert.equal(parseOrganizationRuntimeConfig(omitted).agents[0]?.engine.reasoningEffort, undefined);
});

test("rejects a blank or oversized codex model", () => {
  const blank = valid();
  blank.agents[0]!.engine = { kind: "codex", model: "   " } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(blank), /model/);

  const oversized = valid();
  oversized.agents[0]!.engine = { kind: "codex", model: "x".repeat(ORGANIZATION_RUNTIME_MAX_STRING_BYTES + 1) } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(oversized), /model/);
});

test("rejects an unrecognized codex reasoningEffort value", () => {
  const invalid = valid();
  invalid.agents[0]!.engine = { kind: "codex", reasoningEffort: "turbo" } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(invalid), /reasoningEffort/);
});

test("the engine JSON Schema and the parser agree on model/reasoningEffort", () => {
  const engineSchema = ORGANIZATION_RUNTIME_CONFIG_SCHEMA.properties.agents.items.properties.engine;
  assert.deepEqual(Object.keys(engineSchema.properties).sort(), ["codexSandbox", "kind", "model", "reasoningEffort", "turnTimeoutMs"]);
  assert.deepEqual(engineSchema.required, ["kind"]);
  assert.deepEqual(engineSchema.properties.reasoningEffort.enum, ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS);
  for (const value of ORGANIZATION_RUNTIME_CODEX_REASONING_EFFORTS) {
    const config = valid();
    config.agents[0]!.engine = { kind: "codex", reasoningEffort: value } as never;
    assert.equal(parseOrganizationRuntimeConfig(config).agents[0]?.engine.reasoningEffort, value);
  }
});

test("accepts only the narrow optional Codex workspace policy", () => {
  const config = valid();
  config.agents[0]!.engine = { kind: "codex", codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } } as never;
  assert.deepEqual(parseOrganizationRuntimeConfig(config).agents[0]?.engine.codexSandbox, { mode: "workspace-write", networkAccess: false, webSearch: "disabled" });
  for (const policy of [
    { mode: "danger-full-access", networkAccess: false, webSearch: "disabled" },
    { mode: "workspace-write", networkAccess: true, webSearch: "disabled" },
    { mode: "workspace-write", networkAccess: false, webSearch: "enabled" },
    { mode: "workspace-write", networkAccess: false, webSearch: "disabled", extra: true }
  ]) {
    const invalid = valid();
    invalid.agents[0]!.engine = { kind: "codex", codexSandbox: policy } as never;
    assert.throws(() => parseOrganizationRuntimeConfig(invalid), /codexSandbox/);
  }
});

test("rejects model and reasoningEffort on agy, and codexSandbox on every non-codex engine", () => {
  const withModel = valid();
  withModel.agents[0]!.engine = { kind: "agy", model: "gpt-5-codex" } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(withModel), /codex-only/);
  const withEffort = valid();
  withEffort.agents[0]!.engine = { kind: "agy", reasoningEffort: "high" } as never;
  assert.throws(() => parseOrganizationRuntimeConfig(withEffort), /codex-only/);
  for (const kind of ["grok", "agy"] as const) {
    const withPolicy = valid();
    withPolicy.agents[0]!.engine = { kind, codexSandbox: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } } as never;
    assert.throws(() => parseOrganizationRuntimeConfig(withPolicy), /codex-only/);
  }
});

const withMemory = (agent: Record<string, unknown>, memory: unknown): Record<string, unknown> => ({ ...agent, memory });

test("parses a declared memory bank and round-trips its fields", () => {
  const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/memory/editor", source: "editor-notes", tokenBudget: 4000 });
  const parsed = parseOrganizationRuntimeConfig(config);
  assert.deepEqual(parsed.agents[0]?.memory, { runtimeHomePath: "/runtime/memory/editor", source: "editor-notes", tokenBudget: 4000 });
});

test("parses a memory bank with only runtimeHomePath and omits absent optional keys", () => {
  const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/memory/editor" });
  const parsed = parseOrganizationRuntimeConfig(config);
  assert.deepEqual(parsed.agents[0]?.memory, { runtimeHomePath: "/runtime/memory/editor" });
  assert.equal(Object.hasOwn(parsed.agents[0]?.memory ?? {}, "source"), false);
  assert.equal(Object.hasOwn(parsed.agents[0]?.memory ?? {}, "tokenBudget"), false);
});

test("rejects malformed memory declarations", () => {
  const relative = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  relative.agents[0] = withMemory(relative.agents[0]!, { runtimeHomePath: "memory/editor" });
  assert.throws(() => parseOrganizationRuntimeConfig(relative), /absolute POSIX/);

  const unknownKey = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  unknownKey.agents[0] = withMemory(unknownKey.agents[0]!, { runtimeHomePath: "/runtime/memory/editor", extra: "nope" });
  assert.throws(() => parseOrganizationRuntimeConfig(unknownKey), /invalid fields/);

  for (const tokenBudget of [0, 1_000_001, 1.5]) {
    const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
    config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/memory/editor", tokenBudget });
    assert.throws(() => parseOrganizationRuntimeConfig(config), /tokenBudget must be an integer between 1 and 1000000/);
  }
});

test("rejects a declared memory bank overlapping another agent's roots", () => {
  for (const value of ["/runtime/homes/editor", "/runtime/workspaces/editor", "/runtime/workspaces/editor/nested"]) {
    const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
    config.agents.push(withMemory({ ...config.agents[0]!, id: "other", workspacePath: "/runtime/workspaces/other", runtimeHomePath: "/runtime/homes/other" }, { runtimeHomePath: value }));
    assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
  }
});

test("accepts a declared memory bank nested inside its own agent's runtimeHomePath", () => {
  const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/homes/editor/memory" });
  const parsed = parseOrganizationRuntimeConfig(config);
  assert.equal(parsed.agents[0]?.memory?.runtimeHomePath, "/runtime/homes/editor/memory");
});

test("rejects a declared memory bank nested inside its own agent's workspacePath", () => {
  const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/workspaces/editor/memory" });
  assert.throws(() => parseOrganizationRuntimeConfig(config), /must not overlap/);
});

test("accepts two agents sharing one identical declared memory bank", () => {
  const config = valid() as Record<string, unknown> & { agents: Record<string, unknown>[] };
  config.agents[0] = withMemory(config.agents[0]!, { runtimeHomePath: "/runtime/memory/shared" });
  config.agents.push(withMemory({ ...config.agents[0]!, id: "other", workspacePath: "/runtime/workspaces/other", runtimeHomePath: "/runtime/homes/other" }, { runtimeHomePath: "/runtime/memory/shared" }));
  const parsed = parseOrganizationRuntimeConfig(config);
  assert.equal(parsed.agents[0]?.memory?.runtimeHomePath, "/runtime/memory/shared");
  assert.equal(parsed.agents[1]?.memory?.runtimeHomePath, "/runtime/memory/shared");
});

test("wake-result status and code pairs are fixed", () => {
  const fixtures = [
    { version: "noopolis.daimon.wake-result.v1", status: "completed", agentId: "a", wakeId: "w", text: "done", durationMs: 1 },
    { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "a", wakeId: "w", code: "unauthorized" },
    { version: "noopolis.daimon.wake-result.v1", status: "rejected", agentId: "a", wakeId: "w", code: "queue_full" },
    { version: "noopolis.daimon.wake-result.v1", status: "stopped", agentId: "a", wakeId: "w", code: "queued_wake_stopped" },
    { version: "noopolis.daimon.wake-result.v1", status: "failed", agentId: "a", wakeId: "w", code: "engine_failed" }
  ] as const;
  assert.deepEqual(fixtures.map((result) => result.status), ["completed", "rejected", "rejected", "stopped", "failed"]);
});
