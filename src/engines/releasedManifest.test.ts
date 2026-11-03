import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

test("manifest v7 pins the canonical emitted bytes including engine descriptors", () => {
  const bytes = `${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`;
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "sha256:0f9d9c57f4455da7f4e07d399245e926d9d13a1092f607f41ba8e9e5cc964be6");
});
