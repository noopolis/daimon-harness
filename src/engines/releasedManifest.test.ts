import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

test("manifest v7 pins the canonical emitted bytes including engine descriptors", () => {
  const bytes = `${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`;
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "sha256:e6eedf2e83af312b33328ab3e768e888e132f53f6db3c1c6ce3768adff439da9");
});
