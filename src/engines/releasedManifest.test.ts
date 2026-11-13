import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../contracts/canonicalJson.js";
import { RUNTIME_CONTRACT_MANIFEST } from "../contracts/runtimeContractManifest.js";

test("manifest v7 pins the canonical emitted bytes including engine descriptors", () => {
  const bytes = `${canonicalJson(RUNTIME_CONTRACT_MANIFEST)}\n`;
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    "sha256:481f189e8b7d7e5927e215ed0d30d0d963b5b6d1677b87374bed929ee6a39608");
});
