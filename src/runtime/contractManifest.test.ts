import assert from "node:assert/strict";
import test from "node:test";

import { AGY_SUBSCRIPTION_REALM, CODEX_SUBSCRIPTION_REALM, canonicalJson, canonicalRuntimeContractManifest, ENGINE_CREDENTIAL_MATERIAL, GROK_SUBSCRIPTION_REALM, RUNTIME_CONTRACT_MANIFEST, RUNTIME_CONTRACT_MANIFEST_VERSION } from "./contractManifest.js";

test("runtime contract manifest is data-only and deterministic", () => {
  const first = canonicalRuntimeContractManifest();
  assert.equal(first, canonicalRuntimeContractManifest());
  assert.equal(first, canonicalJson(RUNTIME_CONTRACT_MANIFEST));
  assert.deepEqual(Object.keys(ENGINE_CREDENTIAL_MATERIAL), ["codex"]);
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.supportedEngineKinds, ["agy", "codex", "grok"]);
  assert.equal(RUNTIME_CONTRACT_MANIFEST_VERSION, "noopolis.daimon.runtime-contract-manifest.v7");
  assert.equal(RUNTIME_CONTRACT_MANIFEST.organizationRuntimeConfigV2Schema.$id, "noopolis.daimon.organization-runtime.v2");
  const v2 = RUNTIME_CONTRACT_MANIFEST.organizationRuntimeConfigV2Schema.properties.agents.items.properties;
  assert.deepEqual(v2.memory.properties.dreamSchedule, v2.schedule);
  assert.ok(!Object.hasOwn(RUNTIME_CONTRACT_MANIFEST.organizationRuntimeConfigSchema.properties.agents.items.properties.memory.properties, "dreamSchedule"));
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.wakeAcceptanceTypes, ["manual", "message", "schedule", "external"]);
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.deliverySemantics, {
    activeDeliveryIdempotency: "unbounded-until-terminal", terminalReceiptHorizon: 2_048,
    recovery: "at-least-once-with-stable-wake-id", concurrentSameAgentTurns: false, externalEffectsExactlyOnce: false
  });
  assert.equal(RUNTIME_CONTRACT_MANIFEST.activityV2ResponseSchema.properties.version.const, "noopolis.daimon.organization-runtime-activity.v2");
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.wakeRequestSchema.properties.event.properties.kind.enum, ["manual", "message", "schedule", "external"]);
  assert.equal("maximum" in RUNTIME_CONTRACT_MANIFEST.wakeResultSchema.oneOf[0].properties.durationMs, false);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.agySubscriptionRealm, AGY_SUBSCRIPTION_REALM);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.grokSubscriptionRealm, GROK_SUBSCRIPTION_REALM);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.codexSubscriptionRealm, CODEX_SUBSCRIPTION_REALM);
  assert.equal(CODEX_SUBSCRIPTION_REALM.agentCredentialRelativePath, ".codex/auth.json");
  assert.equal(RUNTIME_CONTRACT_MANIFEST.engines.codex.auth.staging, "portable-realm");
  assert.equal(GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath, ".grok/auth.json");
  assert.equal(AGY_SUBSCRIPTION_REALM.directoryMode, 0o700);
  assert.equal(AGY_SUBSCRIPTION_REALM.fileMode, 0o600);
  assert.doesNotMatch(first, /antigravity-oauth-token|agy-auth/);
  assert.doesNotMatch(first, /argv|credential value/i);
  // v6 declares AGY's required binaries and bus variable as static capability data.
  // Keep the exclusion everywhere except those exact, intentional fields.
  const data = JSON.parse(first);
  assert.equal(data.engines.agy.auth.busEnvironment, "DBUS_SESSION_BUS_ADDRESS");
  assert.deepEqual(data.engines.agy.requiredBinaries, ["agy", "dbus-daemon", "gnome-keyring-daemon"]);
  delete data.engines.agy.auth.busEnvironment;
  delete data.engines.agy.requiredBinaries;
  assert.doesNotMatch(canonicalJson(data), /DBUS_SESSION_BUS_ADDRESS|gnome-keyring|dbus-daemon/i);
  for (const rule of Object.values(ENGINE_CREDENTIAL_MATERIAL)) {
    assert.equal(rule.directoryMode, 0o700);
    assert.equal(rule.fileMode, 0o600);
    assert.ok(!rule.sourceRelativePath.startsWith("/") && !rule.sourceRelativePath.includes(".."));
    assert.ok(!rule.destinationRelativePath.startsWith("/") && !rule.destinationRelativePath.includes(".."));
  }
});

test("canonical JSON rejects values with lossy or environment-dependent encodings", () => {
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -0, 1n, [, "value"], new Date(0)]) {
    assert.throws(() => canonicalJson(value));
  }
  assert.throws(() => canonicalJson({ value: undefined }));
  assert.throws(() => canonicalJson("\ud800"));
});

test("consumedConfigFields names every agent field the organization runtime schema accepts", () => {
  const schemaAgentFields = Object.keys(
    RUNTIME_CONTRACT_MANIFEST.organizationRuntimeConfigV2Schema.properties.agents.items.properties
  ).sort();
  const declaredAgentFields = [...new Set(
    RUNTIME_CONTRACT_MANIFEST.consumedConfigFields
      .filter((field) => field.startsWith("agents[]."))
      .map((field) => field.slice("agents[].".length).split(".")[0])
  )].sort();
  assert.deepEqual(
    schemaAgentFields.filter((field) => !declaredAgentFields.includes(field)),
    [],
    "every agent property the runtime parses must be listed in consumedConfigFields"
  );
});
