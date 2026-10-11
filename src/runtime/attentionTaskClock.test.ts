import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attentionTools, type AttentionRegistry } from "./attention.js";
import { WakeFuse, type WakeBudgetSnapshot } from "./wakeFuse.js";

test("inbox renders the task date in the existing epoch shape while fuse rollover stays real", async (t) => {
  const previous = process.env;
  let realNow = Date.parse("2026-10-11T12:00:00Z");
  process.env = { ...previous, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T23:59:00Z", anchorEpochMs: realNow }) };
  t.mock.timers.enable({ apis: ["Date"], now: realNow });
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-budget-clock-"));
  const fuse = await WakeFuse.open({ organizationKey: "a", environment: { DAIMON_WAKE_FUSE_DIRECTORY: root, DAIMON_TURN_USAGE_LEDGER_PATH: path.join(root, "usage.jsonl"), DAIMON_WAKE_FUSE_MAX_WAKES: "1" } });
  t.after(async () => { await fuse.close(); process.env = previous; await rm(root, { recursive: true, force: true }); });
  await fuse.admit("a", "delivery");
  const registry: AttentionRegistry = new Map();
  const dispositions: string[] = [];
  registry.set("a", { executionId: "execution", messages: [{ acceptance_id: "receipt", delivery_id: "delivery", kind: "message", text: "work", occurred_at: "2001-01-01T23:59:00Z" }], budget: () => fuse.snapshot("a"), disposition: async (id) => { dispositions.push(id); } });
  const tools = attentionTools("a", registry);
  const read = async () => {
    const result = await tools[0]!.execute("read", {}, undefined, undefined, {} as never);
    assert.equal((result.content[0] as { text: string }).text, JSON.stringify(result.details));
    return (result.details as { budget: WakeBudgetSnapshot }).budget;
  };
  const internal = await fuse.snapshot("a"), visible = await read();
  assert.match(internal.epoch, /2026-10-11$/u);
  assert.equal(visible.epoch, internal.epoch.replace("2026-10-11", "2001-01-01"));
  assert.notEqual(visible.epoch, internal.epoch);
  assert.deepEqual({ ...visible, epoch: internal.epoch }, internal);
  assert.equal(visible.state, "paused");
  assert.equal((await read()).epoch, visible.epoch);
  await tools[1]!.execute("complete", { delivery_id: "delivery", disposition: "complete" }, undefined, undefined, {} as never);
  assert.deepEqual(dispositions, ["delivery"]);
  realNow += 120000; t.mock.timers.setTime(realNow); // Task midnight does not renew the operator's budget.
  assert.equal((await read()).epoch, visible.epoch.replace("2001-01-01", "2001-01-02"));
  assert.equal((await fuse.snapshot("a")).state, "paused");
  realNow = Date.parse("2026-10-12T00:00:00Z"); t.mock.timers.setTime(realNow);
  const renewed = await read();
  assert.notEqual(renewed.epoch, visible.epoch);
  assert.equal(renewed.state, "available");
  assert.equal(renewed.executions_used, 0);
  assert.match(await readFile(path.join(root, "admissions.jsonl"), "utf8"), /2026-10-11/u);
  delete process.env.NOOPOLIS_TASK_CLOCK;
  assert.deepEqual(await read(), await fuse.snapshot("a"), "unset output remains unchanged");
});
