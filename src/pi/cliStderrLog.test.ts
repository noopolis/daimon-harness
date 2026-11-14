import assert from "node:assert/strict";
import test from "node:test";

import { CLI_STDERR_LOG_MAX_LINE_BYTES, createCliStderrLog } from "./cliStderrLog.js";

const SECRET = "live-secret-0123456789";
const collect = (secrets: readonly string[] = [SECRET]) => {
  const lines: string[] = [];
  return { lines, log: createCliStderrLog("wake=w-1", secrets, (text) => { lines.push(text); }) };
};

test("forwards every stderr line whole, however the chunks fall, far past the failure excerpt", () => {
  const { lines, log } = collect();
  const source = Array.from({ length: 5_000 }, (_, index) => `line ${index} of the engine's account`);
  const bytes = Buffer.from(`${source.join("\n")}\ntrailing without newline`, "utf8");
  for (let at = 0; at < bytes.length; at += 777) log.observe(bytes.subarray(at, at + 777));
  log.finish();
  assert.equal(lines.length, 5_001);
  assert.equal(lines[0], "daimon: engine stderr wake=w-1 | line 0 of the engine's account\n");
  assert.equal(lines[4_999], "daimon: engine stderr wake=w-1 | line 4999 of the engine's account\n");
  assert.equal(lines[5_000], "daimon: engine stderr wake=w-1 | trailing without newline\n");
});

test("redacts a secret split across chunks and credential shapes", () => {
  const { lines, log } = collect();
  log.observe(Buffer.from(`fatal: token live-sec`));
  log.observe(Buffer.from(`ret-0123456789 rejected\nAuthorization: Bearer abcdefghijklmnop\r\n`));
  log.finish();
  assert.deepEqual(lines, ["daimon: engine stderr wake=w-1 | fatal: token [REDACTED] rejected\n", "daimon: engine stderr wake=w-1 | Authorization: Bearer [REDACTED]\n"]);
});

test("bounds a stretch with no line end without ever cutting a secret in two", () => {
  const { lines, log } = collect();
  const filler = "x".repeat(CLI_STDERR_LOG_MAX_LINE_BYTES - 5);
  log.observe(Buffer.from(`${filler}${SECRET.slice(0, 10)}`));
  assert.equal(lines.length, 1);
  log.observe(Buffer.from(`${SECRET.slice(10)} done\n`));
  log.finish();
  const text = lines.join("");
  assert.ok(!text.includes(SECRET.slice(0, 10)) && !text.includes(SECRET.slice(10)));
  assert.ok(text.includes("[REDACTED] done"));
  assert.equal(text.replace(/daimon: engine stderr wake=w-1 \| |\n/gu, "").replace("[REDACTED] done", "").length, filler.length);
});

test("writes nothing for an empty stream or blank lines", () => {
  const { lines, log } = collect([]);
  log.observe(Buffer.from("\n\n"));
  log.finish();
  assert.deepEqual(lines, []);
});
