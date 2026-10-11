import assert from "node:assert/strict";
import test from "node:test";
import { parseOrganizationRuntimeConfig, ORGANIZATION_RUNTIME_CONFIG_SCHEMA, ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA } from "./organizationRuntime.js";
import { RUNTIME_CONTRACT_MANIFEST } from "./contractManifest.js";

const recording = () => ({ directory: "/recordings/a", keepMs: 2_592_000_000, snapshots: [{ id: "edition-state", path: "/shared/state" }] });
const config = (value?: unknown, v2 = false) => ({
  version: `noopolis.daimon.organization-runtime.${v2 ? "v2" : "v1"}`,
  host: { bindHost: "127.0.0.1", port: 4318, controlTokenEnv: "TOKEN" },
  agents: [{ id: "a", name: "A", instructions: "Work", workspacePath: "/work/a", runtimeHomePath: "/home/a", engine: { kind: "codex" },
    ...(v2 ? { schedule: { kind: "disabled" } } : {}), ...(value === undefined ? {} : { recording: value }) }]
});

test("recording is optional in both versions, normalizes paths, and preserves absent config exactly", () => {
  for (const v2 of [false, true]) {
    assert.deepEqual(parseOrganizationRuntimeConfig(config(undefined, v2)), config(undefined, v2));
    assert.deepEqual(parseOrganizationRuntimeConfig(config(recording(), v2)).agents[0]!.recording, recording());
    const normalized = parseOrganizationRuntimeConfig(config({ ...recording(), directory: "/recordings//a/", snapshots: [{ id: "..", path: "/shared/x/../state/" }] }, v2));
    assert.deepEqual(normalized.agents[0]!.recording, { ...recording(), snapshots: [{ id: "..", path: "/shared/state" }] });
    assert.equal(parseOrganizationRuntimeConfig(config({ ...recording(), snapshots: [] }, v2)).agents[0]!.recording!.snapshots.length, 0);
    assert.equal(parseOrganizationRuntimeConfig(config({ ...recording(), snapshots: Array.from({ length: 16 }, (_, i) => ({ id: String(i), path: `/s/${i}` })) }, v2)).agents[0]!.recording!.snapshots.length, 16);
  }
});

test("recording rejects every shape, bound, duplicate, and overlap violation in both versions", () => {
  const bad: unknown[] = [null, [], {}, { directory: "/rec", keepMs: 1 }, { ...recording(), hook: "run" },
    ...[0, -1, 1.1, "1", Number.MAX_SAFE_INTEGER + 1, Infinity].map((keepMs) => ({ ...recording(), keepMs })),
    ...["relative", "", "/bad\0path", "/" + "x".repeat(4096), "/", "/work/a", "/work/a/child", "/work", "/home/a", "/home/a/child", "/home"].map((directory) => ({ ...recording(), directory })),
    { ...recording(), snapshots: {} }, { ...recording(), snapshots: Array.from({ length: 17 }, (_, i) => ({ id: String(i), path: `/s/${i}` })) },
    ...["", "bad id", "a/b", "a".repeat(129)].map((id) => ({ ...recording(), snapshots: [{ id, path: "/state" }] })),
    ...["relative", "/bad\0path", "/recordings/a", "/recordings/a/child", "/recordings", "/"].map((path) => ({ ...recording(), snapshots: [{ id: "s", path }] })),
    { ...recording(), snapshots: [{ id: "s" }] }, { ...recording(), snapshots: [{ id: "s", path: "/s", env: {} }] },
    { ...recording(), snapshots: [{ id: "s", path: "/s" }, { id: "s", path: "/t" }] },
    { ...recording(), snapshots: [{ id: "s", path: "/s" }, { id: "t", path: "/x/../s/" }] }
  ];
  for (const value of bad) for (const v2 of [false, true]) assert.throws(() => parseOrganizationRuntimeConfig(config(value, v2)), TypeError, JSON.stringify(value));
});

test("shared snapshot sources are allowed; recording stores cannot overlap peer roots", () => {
  const input = config(recording());
  input.agents.push({ ...input.agents[0]!, id: "b", workspacePath: "/work/b", runtimeHomePath: "/home/b", recording: { ...recording(), directory: "/recordings/b" } });
  assert.doesNotThrow(() => parseOrganizationRuntimeConfig(input));
  input.agents[1]!.recording = { ...recording(), directory: "/work/a/recordings" };
  assert.throws(() => parseOrganizationRuntimeConfig(input), /overlap/);
});

test("both schemas and the capability manifest expose the closed recording shape", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js") as unknown as { Ajv2020: new (options: object) => { compile(schema: unknown): (value: unknown) => boolean } };
  for (const [v2, schema] of [[false, ORGANIZATION_RUNTIME_CONFIG_SCHEMA], [true, ORGANIZATION_RUNTIME_CONFIG_V2_SCHEMA]] as const) {
    const validate = new Ajv2020({ strict: false }).compile(schema);
    assert.equal(validate(config(recording(), v2)), true);
    assert.equal(validate(config(undefined, v2)), true);
    for (const value of [{ ...recording(), extra: 1 }, { ...recording(), keepMs: 0 }, { ...recording(), directory: "relative" }, { ...recording(), snapshots: [{ id: "bad/id", path: "/s" }] }]) assert.equal(validate(config(value, v2)), false);
  }
  assert.deepEqual(RUNTIME_CONTRACT_MANIFEST.wakeMoments, {
    version: "noopolis.daimon.wake-moment.v1", rowsFile: "wake-moments.jsonl", snapshotsDirectory: "snapshots",
    completionSuffix: ".complete", maxSnapshotRoots: 16, maxSnapshotEntries: 200_000, maxRowBytes: 4_194_304,
    maxManifestBytes: 134_217_728, captureDeadlineMs: 60_000, finalizationDeadlineMs: 1_000, configField: "agents[].recording"
  });
  assert.ok(RUNTIME_CONTRACT_MANIFEST.consumedConfigFields.includes("agents[].recording"));
});
