import assert from "node:assert/strict";
import test from "node:test";

import { ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA } from "../contracts/organizationRuntimeContract.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";
import { ORGANIZATION_RUNTIME_VERSION, parseOrganizationRuntimeConfig } from "../runtime/organizationRuntime.js";
import { agyRuntimeHooks } from "./agy/runtimeHooks.js";
import { codexRuntimeHooks } from "./codex/runtimeHooks.js";

const config = (engine: Record<string, unknown>) => parseOrganizationRuntimeConfig({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "DAIMON_TURN_TIMEOUT_TEST_TOKEN" },
  agents: [{ id: "writer", name: "Writer", instructions: "Write.", workspacePath: "/runtime/workspace", runtimeHomePath: "/runtime/home", engine }]
});
const sessionTimeout = (hooks: typeof agyRuntimeHooks, engine: Record<string, unknown>): unknown => {
  const agent = config(engine).agents[0]!;
  const options = hooks.runtimeSessionOptions({ agent, engineHomePath: "/runtime/home", wakeEnvironmentContext: {}, sandbox: {} } as never) as { timeoutMs?: number };
  return options.timeoutMs;
};

test("a declared engine turn timeout bounds Codex and AGY turns; absent keeps each engine's default", () => {
  assert.equal(sessionTimeout(agyRuntimeHooks, { kind: "agy" }), 180_000);
  assert.equal(sessionTimeout(agyRuntimeHooks, { kind: "agy", turnTimeoutMs: 1_800_000 }), 1_800_000);
  assert.equal(sessionTimeout(codexRuntimeHooks, { kind: "codex" }), 240_000);
  assert.equal(sessionTimeout(codexRuntimeHooks, { kind: "codex", turnTimeoutMs: 1_800_000 }), 1_800_000);
});

test("AGY honors the engine-neutral DAIMON_ENGINE_WAKE_TIMEOUT_MS below a declared field, like Codex", () => {
  const previous = process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS;
  process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS = "600000";
  try {
    assert.equal(sessionTimeout(agyRuntimeHooks, { kind: "agy" }), 600_000);
    assert.equal(sessionTimeout(agyRuntimeHooks, { kind: "agy", turnTimeoutMs: 2_700_000 }), 2_700_000);
    assert.equal(sessionTimeout(codexRuntimeHooks, { kind: "codex" }), 600_000);
  } finally {
    if (previous === undefined) delete process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS; else process.env.DAIMON_ENGINE_WAKE_TIMEOUT_MS = previous;
  }
});

test("the engine turn timeout is bounded, CLI-engine only and published in the contract", () => {
  for (const value of [999, 3_600_001, 1.5, "1800000"]) {
    assert.throws(() => config({ kind: "agy", turnTimeoutMs: value }), /turnTimeoutMs must be an integer from 1000 to 3600000/u);
    assert.throws(() => config({ kind: "codex", turnTimeoutMs: value }), /turnTimeoutMs must be an integer from 1000 to 3600000/u);
  }
  // Grok bounds its turns through its broker registration (`turn_limits`), never here.
  assert.throws(() => config({ kind: "grok", turnTimeoutMs: 1_800_000 }), /must contain exactly/u);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.consumedConfigFields.at(-1), "agents[].engine.turnTimeoutMs");
  const engine = ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA.properties.agents.items.properties.engine;
  assert.deepEqual(engine.properties.turnTimeoutMs, { type: "integer", minimum: 1_000, maximum: 3_600_000 });
});
