# Static engine descriptors

`src/engines/descriptors.ts` is the compiler/trainer inventory. It imports only
static data from `descriptorContracts.ts` and the broker task-clock contract;
loading it never loads a handler, touches credentials, or probes a CLI. A
consumer can serialize `ENGINE_DESCRIPTORS` directly to generate its mirror.
Keep the descriptor-source commit pinned independently of deployed images.

- `ENGINE_IDS` preserves the released configuration-schema order.
  `SORTED_ENGINE_IDS` preserves the manifest/diagnostic order.
- `authKinds`, `auth.method`, and `auth.provider` describe subscription intent.
  Null method/provider means auth is runtime-owned rather than model-declared.
- `auth.staging` distinguishes a portable ingress file, a broker-owned credential
  realm, and a Secret Service realm. `credentialMaterial` describes the agent
  destination; only a portable-file engine has an ingress source there. Broker
  bootstrap and Secret Service unlock sources, paths, modes and bounds are in
  `auth.realm`. `homeDirectory` is relative to the agent runtime home (empty
  means that home itself); `homeEnvironment` selects the native CLI home.
- Portable engines expose `auth.fileName`, modes, `maxCredentialBytes`, and
  `auth.format`. Codex searches a nested token object then the root if absent;
  Grok searches the first matching authority entry and requires a parseable
  expiration string. These are structural refresh checks, not live login probes.
  Pi OAuth bridging additionally needs a nested account id; the broker credential
  reader has its own stricter single-entry/token-length validation.
- `diagnostics.paths` lists the engine's own records of its turns (session
  transcripts, CLI logs), relative to the agent runtime home, for a consumer
  that keeps a run's evidence after its container is gone. A listed path may be
  absent on a given run. It never lists a credential, a login file or a
  directory holding one: AGY keeps its login beside its records, so its entries
  are named one by one and never its whole CLI home. A consumer still owns
  collection, bounds and scrubbing.
- `modelSelection` describes organization-runtime declarations. Codex accepts
  any nonblank model string and a closed effort vocabulary. Null defaults mean
  Daimon supplies no CLI override. AGY exposes neither option. Grok accepts
  neither model nor effort, or both from closed lists; a declared pair requires
  the broker. Its defaults apply at legacy v1 broker registration, not config parsing; v2/v3
  registration requires the pair. Declaration flags describe fixed handler
  invariants, not independent feature switches. General string bounds remain in
  the runtime config schema; a consumer may impose a narrower receipt bound.
  `DEFAULT_PI_MODEL` is a separate API-model default, not a Codex CLI default.
- `sandbox` exposes the configurable Codex policy and fixed Grok profile,
  network restriction and deny-path syntax.
  `capabilities` describes runtime mechanisms; `requiredBinaries` describes the
  native prerequisites.
- `broker` is null or the complete existing broker contract, including control
  protocol id, ABI, binaries, identities, paths, worker pins, clock/slot contract,
  turn-limit bounds/defaults, accounting, and inference grants. Worker config
  bytes must still come from the renderer and match those pins.
- `training.subject` declares evaluator-isolation capability: Codex's native
  sandbox, Grok's broker worker, or unsupported for AGY's unconfined built-ins.
  It does not certify a compiler's adapter or receipt format. A compiler can
  support a narrower set. `training.inferenceGrants` exposes evaluator grant
  capability; its models and efforts use the same `modelSelection` vocabulary.

Compiler policy stays with the consumer: default engine, required model
intent, provider/endpoint restrictions, fallbacks, dedicated training logins,
profile selection/writeback, runtime image pins, mount allocation, evaluator
roots, launch receipts, adapter registration, scheduling and budgets chosen
within Daimon's limits. Standalone judge-provider tuning that bypasses Daimon's
runtime/broker is also consumer policy, not a Daimon model guarantee.

The manifest now emits `noopolis.daimon.runtime-contract-manifest.v6`: every v5
section is retained and `engines: { <id>: descriptor }` directly aliases this
inventory. `supportedEngineKinds` is the sorted inventory, and retained credential,
realm and broker sections canonically agree with their owning descriptors.

The canonical UTF-8 JSON plus trailing newline now hashes to
`sha256:9f91388983cc5308137ba0259302b9faec75a9f0e032b2a031b6a774ff3f409f`.
The digest changes because the version is v6 and the descriptors are included;
removing `engines` and restoring the v5 version reproduces the released v5 digest
`sha256:e39551277c6727c8807b1247e759f57addcee3f17f1405ebc927179647d64de6`.
Package version 0.2.8 is unchanged here; release and consumer re-pinning are
separate steps.

Cross-repo conformance uses the unchanged Spawnfile parser and its complete local
import closure from `origin/main` commit
`c7d97dc9b6c5905189cbaecff167a1abcf81206c` (after PR #114). Like the existing
adjacent contract fixtures, it is checked-in test data. The snapshot records
source paths, commit and SHA-256 hashes in
`src/runtime/fixtures/spawnfile-contract-parser.json`; tests materialize it in an
ignored temporary directory, invoke the real emitter there, and run Spawnfile's
canonical-byte/digest verifier and v6 parser against the resulting files.
Negative cases cover inventory, schema, credential, realm and broker drift.
It requires neither a sibling checkout nor network access during tests and adds
no Spawnfile runtime dependency or packaged parser code.

`scripts/vendorSpawnfileContractParser.ts` refreshes the snapshot from an absolute
Spawnfile checkout and Git ref, using only committed Git objects, following
Spawnfile's descriptor-mirror generation pattern. Its optional `--check` compares
the fixture byte-for-byte with that exact Git revision. Refreshes require a
deliberate commit-pin update and review of the upstream source changes.

Tests compare descriptors with configuration parsing, rendered worker/grant
pins, omitted defaults, limit enforcement, credential readers and isolation
hooks. A transitive AST boundary test rejects executable imports in the static
inventory.
