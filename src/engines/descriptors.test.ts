import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";

import { ENGINE_DESCRIPTORS, ENGINE_IDS, SORTED_ENGINE_IDS, DEFAULT_PI_MODEL } from "./descriptors.js";
import { getEngineHandler } from "./registry.js";
import { renderCodexArgs } from "./codex/piArgs.js";
import { parseGrokBrokerModelPolicy } from "./grok/broker/grokBrokerModelPolicy.js";
import { renderGrokBrokerWorkerConfig } from "./grok/broker/grokBrokerWorkerConfig.js";
import { renderGrokWorkerSandboxProfile } from "./grok/broker/grokWorkerSandboxProfile.js";
import { renderGrokInferenceClientConfig } from "./grok/broker/grokInferenceClientConfig.js";
import { ENGINE_BROKER_VERSION, parseEngineBrokerRequest } from "./grok/broker/engineBrokerProtocol.js";
import { lowerEngineBrokerTurnLimits, DEFAULT_GROK_BROKER_TURN_LIMITS, parseEngineBrokerTurnLimitOverrides } from "./grok/broker/engineBrokerTurnAccounting.js";
import { parseOrganizationRuntimeConfig, ORGANIZATION_RUNTIME_CONFIG_SCHEMA, ORGANIZATION_RUNTIME_VERSION } from "../runtime/organizationRuntime.js";
import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

const config = (engine: Record<string, unknown>) => ({
  version: ORGANIZATION_RUNTIME_VERSION,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "CONTROL_TOKEN" },
  agents: [{ id: "subject", name: "Subject", instructions: "Work", workspacePath: "/work/subject", runtimeHomePath: "/homes/subject", engine }]
});
const parse = (engine: Record<string, unknown>) => parseOrganizationRuntimeConfig(config(engine)).agents[0]!.engine;
const grok = ENGINE_DESCRIPTORS.grok;
const sha256 = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

test("legacy aliases, credential destinations and capability flags agree", () => {
  const codex = ENGINE_DESCRIPTORS.codex;
  assert.equal(codex.auth.method, codex.piAuthMethod);
  assert.equal(codex.auth.provider, codex.piSourceProvider);
  for (const id of ENGINE_IDS) {
    const descriptor = ENGINE_DESCRIPTORS[id];
    assert.equal(descriptor.capabilities.broker, descriptor.broker !== null);
    assert.equal(descriptor.capabilities.portableCredential, descriptor.credentialMaterial !== null);
    if (descriptor.training.subject.supported) assert.equal(descriptor.capabilities.nativeSandbox, true);
  }
  for (const id of ["codex", "grok"] as const) {
    const descriptor = ENGINE_DESCRIPTORS[id];
    assert.equal(descriptor.credentialMaterial.destinationRelativePath, path.posix.join(descriptor.homeDirectory, descriptor.auth.fileName));
  }
});

test("descriptor model declarations match the runtime parser and JSON schema", () => {
  const validate = new Ajv2020({ strict: false }).compile(ORGANIZATION_RUNTIME_CONFIG_SCHEMA);
  const accepts = (engine: Record<string, unknown>, expected: boolean) => {
    assert.equal(validate(config(engine)), expected, JSON.stringify(engine));
    if (expected) assert.deepEqual(parse(engine), engine);
    else assert.throws(() => parse(engine), TypeError, JSON.stringify(engine));
  };
  for (const id of ENGINE_IDS) accepts({ kind: id }, true);
  for (const effort of ENGINE_DESCRIPTORS.codex.modelSelection.reasoningEfforts) {
    accepts({ kind: "codex", model: "arbitrary-future-model", reasoningEffort: effort }, true);
  }
  accepts({ kind: "codex", model: "" }, false);
  accepts({ kind: "codex", model: "   " }, false);
  accepts({ kind: "codex", reasoningEffort: "future-effort" }, false);
  for (const model of grok.modelSelection.models.values) for (const reasoningEffort of grok.modelSelection.reasoningEfforts) {
    accepts({ kind: "grok", model, reasoningEffort }, true);
    assert.deepEqual(parseGrokBrokerModelPolicy({ model, reasoningEffort }), { model, reasoningEffort });
    accepts({ kind: "grok", model }, !grok.modelSelection.requiresPairedDeclaration);
  }
  accepts({ kind: "grok", reasoningEffort: "low" }, false);
  accepts({ kind: "grok", model: "unknown", reasoningEffort: "low" }, false);
  accepts({ kind: "grok", model: "grok-4.6", reasoningEffort: "xhigh" }, false);
  for (const id of ENGINE_IDS.filter(id => !ENGINE_DESCRIPTORS[id].modelSelection.configurable)) {
    accepts({ kind: id, model: "custom" }, false);
    accepts({ kind: id, reasoningEffort: "low" }, false);
  }
});

test("broker defaults and every worker model/effort render exactly the descriptor pins", () => {
  // Exercise omission: passing explicit defaults would hide a divergent default path.
  assert.deepEqual(parseGrokBrokerModelPolicy(), grok.modelSelection.defaults);
  const pins = grok.broker.worker.configSha256;
  assert.deepEqual(Object.keys(pins), [...grok.modelSelection.models.values]);
  for (const model of grok.modelSelection.models.values) for (const reasoningEffort of grok.modelSelection.reasoningEfforts) {
    const bytes = renderGrokBrokerWorkerConfig({ model, reasoningEffort });
    assert.equal(sha256(bytes), pins[model][reasoningEffort]);
    assert.ok(bytes.includes(`[model.${grok.broker.worker.modelId}]`));
    assert.ok(bytes.includes(`model = "${model}"`));
    assert.ok(bytes.includes(`reasoning_effort = "${reasoningEffort}"`));
  }
  const defaults = grok.modelSelection.defaults;
  assert.equal(sha256(renderGrokBrokerWorkerConfig()), pins[defaults.model][defaults.reasoningEffort]);
});

test("broker protocol and enforced turn-limit boundaries come from descriptors", () => {
  assert.equal(ENGINE_BROKER_VERSION, grok.broker.controlProtocolVersion);
  assert.deepEqual(parseEngineBrokerRequest({ version: grok.broker.controlProtocolVersion, kind: "health", requestId: "test" }),
    { version: grok.broker.controlProtocolVersion, kind: "health", requestId: "test" });
  const spec = grok.broker.turnLimits;
  assert.deepEqual(DEFAULT_GROK_BROKER_TURN_LIMITS, spec.v1Defaults);
  for (const key of spec.keys) {
    const [min, max] = spec.bounds[key];
    for (const value of [min, max]) assert.equal(parseEngineBrokerTurnLimitOverrides({ [key]: value })[key], value);
    for (const value of [min - 1, max + 1, min + 0.5]) assert.throws(() => parseEngineBrokerTurnLimitOverrides({ [key]: value }));
    assert.equal(lowerEngineBrokerTurnLimits(spec.v1Defaults, { [key]: min })[key], min);
    assert.throws(() => lowerEngineBrokerTurnLimits(spec.v1Defaults, { [key]: spec.v1Defaults[key] + 1 }));
  }
});

test("training grant vocabulary and renderer match the descriptor capability", () => {
  assert.deepEqual(SORTED_ENGINE_IDS.filter(id => ENGINE_DESCRIPTORS[id].training.subject.supported), ["codex", "grok"]);
  assert.equal(ENGINE_DESCRIPTORS.codex.training.subject.isolation, "native-sandbox");
  assert.equal(grok.training.subject.isolation, "broker-worker");
  assert.equal(ENGINE_DESCRIPTORS.agy.training.subject.supported, false);
  const grants = grok.training.inferenceGrants;
  assert.equal(grants, grok.broker.inferenceGrants);
  for (const model of grok.modelSelection.models.values) for (const reasoningEffort of grok.modelSelection.reasoningEfforts) {
    for (const purpose of grants.purposes) {
      const frame = { version: grok.broker.controlProtocolVersion, kind: "request_inference_grant", requestId: "test", model, reasoningEffort, purpose };
      assert.deepEqual(parseEngineBrokerRequest(frame), frame);
    }
    const bytes = renderGrokInferenceClientConfig({ model, reasoningEffort, envKey: grants.client.envKey, baseUrl: `http://${grok.broker.providerProxy.host}:${grok.broker.providerProxy.port}/v1` });
    assert.equal(sha256(bytes), grants.client.configSha256[model][reasoningEffort]);
    assert.ok(bytes.includes(`env_key = "${grants.client.envKey}"`));
  }
  for (const override of [{ model: "unknown" }, { reasoningEffort: "xhigh" }, { purpose: "subject" }]) {
    assert.throws(() => parseEngineBrokerRequest({ version: grok.broker.controlProtocolVersion, kind: "request_inference_grant", requestId: "test", ...grok.modelSelection.defaults, purpose: "judge", ...override }));
  }
});

test("auth homes, environment names, provider mapping and credential formats follow descriptors", () => {
  for (const id of ENGINE_IDS) {
    const descriptor = ENGINE_DESCRIPTORS[id], handler = getEngineHandler(id);
    assert.equal(handler.engineHomePath("/runtime"), path.join("/runtime", descriptor.homeDirectory));
    // Grok never spawns in the agent process: its broker worker gets the home instead.
    assert.equal(handler.environmentVariables({ engineHomePath: "/engine", dbusSessionBusAddress: "unix:path=/bus" })[descriptor.homeEnvironment], id === "grok" ? undefined : "/engine");
  }
  const codex = ENGINE_DESCRIPTORS.codex;
  assert.equal(getEngineHandler("codex").resolvePiProvider!({ provider: codex.auth.provider, name: "any", auth: { method: codex.auth.method } }), codex.piProvider);
  assert.equal(codex.auth.format.fallbackToRoot, true);
  assert.equal(DEFAULT_PI_MODEL.provider, codex.auth.provider);
  const check = (id: "codex" | "grok", source: object, expected = true) =>
    assert.equal(getEngineHandler(id).hasRefreshableCredential(Buffer.from(JSON.stringify(source))), expected);
  for (const access of codex.auth.format.accessTokenKeys) for (const refresh of codex.auth.format.refreshTokenKeys) {
    const pair = { [access]: "access", [refresh]: "refresh" };
    check("codex", { [codex.auth.format.containerKey]: pair });
    check("codex", pair);
  }
  const format = grok.auth.format, entry = { [format.accessTokenKeys[0]]: "access", [format.refreshTokenKeys[0]]: "refresh", [format.expiresAtKey]: "2026-10-23T00:00:00Z" };
  assert.ok(new RegExp(format.entryKeyPattern, "u").test("https://auth.x.ai::test"));
  check("grok", { "https://auth.x.ai::test": entry });
  check("grok", { "https://auth.x.ai::test": { ...entry, [format.expiresAtKey]: "invalid" } }, false);
  check("grok", { "https://evil.test::test": entry }, false);
  check("codex", { access_token: "access" }, false);
  assert.equal(getEngineHandler("agy").hasRefreshableCredential(Buffer.from("{}")), false);
});

test("descriptor sandbox capabilities correspond to the real config and rendered confinement", () => {
  const policy = ENGINE_DESCRIPTORS.codex.sandbox.policy;
  assert.deepEqual(parse({ kind: "codex", codexSandbox: policy }).codexSandbox, policy);
  const args = renderCodexArgs({ codexSandbox: policy }, "/workspace", "http://127.0.0.1:4318/mcp");
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.some(arg => arg.includes('"network"={"enabled"=false}')));
  for (const id of ["grok", "agy"]) assert.throws(() => parse({ kind: id, codexSandbox: policy }));
  const profile = renderGrokWorkerSandboxProfile(["/private/evaluator"]);
  assert.ok(profile.includes(`[profiles.${grok.sandbox.profile}]`));
  assert.ok(profile.includes(`extends = "${grok.sandbox.baseProfile}"`));
  assert.ok(profile.includes("restrict_network = true"));
  const rules = grok.sandbox.denyPaths;
  assert.equal(rules.canonicalAbsolute, true);
  assert.equal(rules.rootAllowed, false);
  assert.equal(rules.trailingSlashAllowed, false);
  for (const denied of ["relative", "/", "/private/evaluator/", "/private/../evaluator", '/private/quote"', "/private/glob*"]) {
    assert.throws(() => renderGrokWorkerSandboxProfile([denied]));
  }
  for (const character of ['"', "\\", "\u0000", "\u001f", "\u007f", "*", "?", "[", "]"]) {
    assert.ok(new RegExp(rules.forbiddenCharacterPattern, "u").test(character));
  }
  const agent = parseOrganizationRuntimeConfig(config({ kind: "grok", ...grok.modelSelection.defaults })).agents[0]!;
  assert.equal(grok.modelSelection.declarationRequiresBroker, true);
  assert.throws(() => getEngineHandler("grok").assertRuntimeLaunch(agent, undefined), /requires the engine broker/);
});

test("manifest v7 emits the static inventory and preserves legacy aliases", () => {
  assert.equal(RUNTIME_CONTRACT_MANIFEST.version, "noopolis.daimon.runtime-contract-manifest.v7");
  assert.equal(sha256(`${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`), "0f9d9c57f4455da7f4e07d399245e926d9d13a1092f607f41ba8e9e5cc964be6");
  assert.equal(RUNTIME_CONTRACT_MANIFEST.engines, ENGINE_DESCRIPTORS);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.grokEngineBroker, grok.broker);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.grokSubscriptionRealm, grok.auth.realm);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.agySubscriptionRealm, ENGINE_DESCRIPTORS.agy.auth.realm);
  assert.equal(RUNTIME_CONTRACT_MANIFEST.engineCredentialMaterial.codex, ENGINE_DESCRIPTORS.codex.credentialMaterial);
});

test("manifest v7 retains every released v5 section byte-for-byte canonically", () => {
  const { engines: _engines, codexSubscriptionRealm: _codexRealm, ...legacy } = RUNTIME_CONTRACT_MANIFEST;
  const v5 = { ...legacy, version: "noopolis.daimon.runtime-contract-manifest.v5" };
  assert.equal(sha256(`${canonicalJson(v5)}\n`), "c5d9ab6ad7314993ac281e62b37dbcea2fe7a42bfb0386b36120770596bc8599");
});
