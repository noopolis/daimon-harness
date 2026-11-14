/** Static engine inventory. This module must never import executable handlers. */
import { CODEX_HOME_DIRECTORY, GROK_HOME_DIRECTORY, PORTABLE_AUTH_FILE_NAME, CODEX_SUBSCRIPTION_INTENT, CODEX_CREDENTIAL_MATERIAL, CODEX_SUBSCRIPTION_REALM, AGY_SUBSCRIPTION_REALM, GROK_ENGINE_BROKER, GROK_SUBSCRIPTION_REALM } from "./descriptorContracts.js";

/**
 * `diagnostics.paths`: the engine's own records of its turns (transcripts, CLI logs), relative to the agent
 * runtime home, for a consumer that keeps a run's evidence after its container is gone. A path may be absent
 * on a given run. Never a credential, login file or login directory: `descriptors.test.ts` holds that line.
 */
export const ENGINE_DESCRIPTORS = {
  codex: {
    id: "codex", piAuthMethod: CODEX_SUBSCRIPTION_INTENT.method, piProvider: CODEX_SUBSCRIPTION_INTENT.piProvider, piSourceProvider: CODEX_SUBSCRIPTION_INTENT.provider, authKinds: ["subscription"],
    credentialMaterial: CODEX_CREDENTIAL_MATERIAL,
    auth: {
      method: CODEX_SUBSCRIPTION_INTENT.method, provider: CODEX_SUBSCRIPTION_INTENT.provider, staging: "portable-realm", realm: CODEX_SUBSCRIPTION_REALM,
      fileName: PORTABLE_AUTH_FILE_NAME, maxCredentialBytes: 64 * 1024,
      directoryMode: CODEX_CREDENTIAL_MATERIAL.directoryMode, fileMode: CODEX_CREDENTIAL_MATERIAL.fileMode,
      format: { containerKey: "tokens", fallbackToRoot: true, accessTokenKeys: ["access_token", "accessToken", "token"], refreshTokenKeys: ["refresh_token", "refreshToken"] }
    },
    modelSelection: {
      configurable: true, models: { kind: "non-empty-string" },
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"],
      // Null means Daimon supplies no CLI override; the installed CLI chooses.
      defaults: { model: null, reasoningEffort: null }, requiresPairedDeclaration: false, declarationRequiresBroker: false
    },
    sandbox: { configurable: true, policy: { mode: "workspace-write", networkAccess: false, webSearch: "disabled" } },
    // This declares containment capability, not a compiler's launch/receipt policy.
    training: { subject: { supported: true, isolation: "native-sandbox" }, inferenceGrants: null },
    broker: null,
    requiredBinaries: ["codex"], homeDirectory: CODEX_HOME_DIRECTORY, homeEnvironment: "CODEX_HOME",
    diagnostics: { paths: [`${CODEX_HOME_DIRECTORY}/sessions`, `${CODEX_HOME_DIRECTORY}/log`] },
    capabilities: { portableCredential: true, nativeSandbox: true, broker: false, secretService: false }
  },
  grok: {
    id: "grok", authKinds: ["subscription"], credentialMaterial: { destinationRelativePath: GROK_SUBSCRIPTION_REALM.agentCredentialRelativePath },
    auth: {
      method: "grok", provider: "xai", staging: "broker-realm", realm: GROK_SUBSCRIPTION_REALM,
      fileName: PORTABLE_AUTH_FILE_NAME, maxCredentialBytes: GROK_SUBSCRIPTION_REALM.maxCredentialBytes,
      directoryMode: GROK_SUBSCRIPTION_REALM.directoryMode, fileMode: GROK_SUBSCRIPTION_REALM.fileMode,
      format: { entryKeyPattern: "^https://auth\\.x\\.ai::", accessTokenKeys: ["key"], refreshTokenKeys: ["refresh_token"], expiresAtKey: "expires_at" }
    },
    modelSelection: {
      configurable: true, models: { kind: "enum", values: GROK_ENGINE_BROKER.worker.models },
      reasoningEfforts: GROK_ENGINE_BROKER.worker.reasoningEfforts,
      // Broker registration defaults; organization config accepts neither or both.
      defaults: { model: GROK_ENGINE_BROKER.worker.defaultModel, reasoningEffort: GROK_ENGINE_BROKER.worker.defaultReasoningEffort },
      requiresPairedDeclaration: true, declarationRequiresBroker: true
    },
    sandbox: {
      configurable: false, profile: "daimon-strict", baseProfile: "strict", restrictNetwork: true,
      denyPaths: { canonicalAbsolute: true, rootAllowed: false, trailingSlashAllowed: false, forbiddenCharacterPattern: "[\"\\\\\\u0000-\\u001f\\u007f*?[\\]]" }
    },
    training: { subject: { supported: true, isolation: "broker-worker" }, inferenceGrants: GROK_ENGINE_BROKER.inferenceGrants },
    // Complete versioned broker contract, including pins, provisioning and turn limits.
    broker: GROK_ENGINE_BROKER,
    requiredBinaries: ["grok", "daimon-engine-broker"], homeDirectory: GROK_HOME_DIRECTORY, homeEnvironment: "GROK_HOME",
    diagnostics: { paths: [`${GROK_HOME_DIRECTORY}/sessions`, `${GROK_HOME_DIRECTORY}/logs`] },
    capabilities: { portableCredential: true, nativeSandbox: true, broker: true, secretService: false }
  },
  agy: {
    id: "agy", authKinds: ["subscription"], credentialMaterial: null,
    auth: { method: null, provider: null, staging: "secret-service", realm: AGY_SUBSCRIPTION_REALM, busEnvironment: "DBUS_SESSION_BUS_ADDRESS", format: null },
    modelSelection: { configurable: false, models: null, reasoningEfforts: [], defaults: { model: null, reasoningEffort: null }, requiresPairedDeclaration: false, declarationRequiresBroker: false },
    sandbox: { configurable: false },
    // Built-in tools have no verified per-agent containment for evaluator secrets.
    training: { subject: { supported: false, isolation: null, reason: "no verified per-agent sandbox" }, inferenceGrants: null },
    broker: null,
    requiredBinaries: ["agy", "dbus-daemon", "gnome-keyring-daemon"], homeDirectory: "", homeEnvironment: "ANTIGRAVITY_CLI_HOME",
    // AGY keeps its login beside these (its OAuth token, installation id and `cache/`); none of them is listed.
    diagnostics: { paths: [".gemini/antigravity-cli/log", ".gemini/antigravity-cli/cli.log", ".gemini/antigravity-cli/brain", ".gemini/antigravity-cli/conversations", ".gemini/antigravity-cli/crashes"] },
    capabilities: { portableCredential: false, nativeSandbox: false, broker: false, secretService: true }
  }
} as const;
export type EngineKind = keyof typeof ENGINE_DESCRIPTORS;
/** Preserve the released schema order separately from the manifest's sorted order. */
export const ENGINE_IDS = [ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id, ENGINE_DESCRIPTORS.agy.id] as const;
export const SORTED_ENGINE_IDS = [ENGINE_DESCRIPTORS.agy.id, ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id] as const;
export const PORTABLE_ENGINE_IDS = [ENGINE_DESCRIPTORS.codex.id, ENGINE_DESCRIPTORS.grok.id] as const;
export type PortableEngineKind = typeof PORTABLE_ENGINE_IDS[number];

/** Pi's API-model default is separate from the Codex CLI's inherited selection. */
export const DEFAULT_PI_MODEL = { auth: { method: ENGINE_DESCRIPTORS.codex.piAuthMethod }, provider: ENGINE_DESCRIPTORS.codex.piSourceProvider, name: "gpt-5.4-mini" } as const;
