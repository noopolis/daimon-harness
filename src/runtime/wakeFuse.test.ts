import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fuseTokens } from "./wakeFuseLedger.js";
import { WakeFuse, WAKE_FUSE_VERSION } from "./wakeFuse.js";

const withDirectory = async (body: (directory: string) => Promise<void>): Promise<void> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "daimon-wake-fuse-"));
  // Provisioning creates the usage ledger alongside the fuse directory in
  // production (`turnUsageLedger.ts`); `WakeFuse.open` now requires it to
  // exist and be readable before arming (see the missing/unreadable-ledger
  // tests below), so every test gets that same provisioned starting point
  // unless it deliberately exercises the missing/unreadable case itself.
  try { await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const withProvisionedDirectory = async (body: (directory: string) => Promise<void>): Promise<void> =>
  await withDirectory(async (directory) => {
    await writeFile(path.join(directory, "usage.jsonl"), "");
    await body(directory);
  });
const environment = (directory: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  DAIMON_WAKE_FUSE_DIRECTORY: directory,
  DAIMON_WAKE_FUSE_EPOCH: "test-epoch",
  DAIMON_WAKE_FUSE_MAX_WAKES: "2",
  DAIMON_WAKE_FUSE_MAX_TOKENS: "1000",
  DAIMON_TURN_USAGE_LEDGER_PATH: path.join(directory, "usage.jsonl"),
  ...values
});
const records = async (directory: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(path.join(directory, "admissions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

test("admission below the ceiling appends exactly one admission", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 1);
}));

test("the n+1 admission trips before append", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await fuse.admit("alpha", "one"); await fuse.admit("alpha", "two");
  assert.deepEqual(await fuse.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 2);
}));

test("concurrent organization admissions cannot overshoot the wake ceiling", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "8" }) });
  const verdicts = await Promise.all(Array.from({ length: 9 }, (_, index) => fuse.admit(`agent-${index % 4}`, `delivery-${index}`)));
  assert.equal(verdicts.filter((verdict) => verdict.state === "admitted").length, 8);
  assert.ok(verdicts.some((verdict) => verdict.state === "tripped"));
  assert.equal((await records(directory)).filter((record) => record.kind === "admission").length, 8);
}));

test("token accounting excludes pre-epoch and skips malformed usage", async () => await withDirectory(async (directory) => {
  const times = [new Date("2026-08-30T00:00:00.000Z"), new Date("2026-08-30T00:00:00.000Z")];
  await writeFile(path.join(directory, "usage.jsonl"), [
    JSON.stringify({ at: "2026-08-29T23:59:59.999Z", total: 5000 }),
    "not-json",
    JSON.stringify({ at: "2026-08-30T00:00:00.000Z", total: 1000 })
  ].join("\n") + "\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory), now: () => times.shift() ?? new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "token_ceiling" });
}));

test("pre-epoch token rows alone cannot trip the ceiling", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "usage.jsonl"), [
    JSON.stringify({ at: "2026-08-29T23:59:59.999Z", total: 5000 }),
    JSON.stringify({ at: "2026-08-30T00:00:00.001Z", total: 10 })
  ].join("\n") + "\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_TOKENS: "100" }), now: () => new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("same-epoch open reloads prior admissions", async () => await withProvisionedDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await first.admit("alpha", "one");
  await first.admit("alpha", "two");
  await first.close();
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await reopened.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
}));

test("a wake ceiling trip is restored with its reason in the same epoch", async () => await withProvisionedDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await first.admit("alpha", "one");
  assert.deepEqual(await first.admit("alpha", "two"), { state: "tripped", reason: "wake_ceiling" });
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.equal(reopened.tripped(), "wake_ceiling");
}));

test("a corrupt trip marker fails closed", async () => await withProvisionedDirectory(async (directory) => {
  await writeFile(path.join(directory, "fuse.trip.json"), "not-json\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.equal(fuse.tripped(), "ledger_unavailable");
}));

test("a valid trip marker from a previous epoch does not trip a new epoch", async () => await withProvisionedDirectory(async (directory) => {
  const first = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_EPOCH: "old", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await first.admit("alpha", "one");
  await first.admit("alpha", "two");
  const fresh = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_EPOCH: "new", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.equal(fresh.tripped(), undefined);
}));

test("token accounting follows the relocated usage ledger", async () => await withDirectory(async (directory) => {
  const elsewhere = path.join(directory, "elsewhere.jsonl");
  await writeFile(elsewhere, `${JSON.stringify({ at: "2026-08-30T00:00:00.000Z", total: 1000 })}\n`);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_TURN_USAGE_LEDGER_PATH: elsewhere }), now: () => new Date("2026-08-30T00:00:00.000Z") });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "token_ceiling" });
}));

test("a malformed usage line alone is skipped", async () => await withDirectory(async (directory) => {
  await writeFile(path.join(directory, "usage.jsonl"), "broken\n");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("admissions from another epoch do not count", async () => await withProvisionedDirectory(async (directory) => {
  await writeFile(path.join(directory, "admissions.jsonl"), `${JSON.stringify({ v: WAKE_FUSE_VERSION, kind: "admission", epoch: "old", at: new Date().toISOString(), agent: "alpha", delivery: "old" })}\n`);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.deepEqual(await fuse.admit("alpha", "new"), { state: "admitted" });
}));

test("operator stop trips on the next admission", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await writeFile(path.join(directory, "fuse.stop"), "ignored");
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "operator_stop" });
}));

test("an append failure refuses admission and fails closed", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  await unlink(path.join(directory, "admissions.jsonl"));
  await mkdir(path.join(directory, "admissions.jsonl"));
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "tripped", reason: "ledger_unavailable" });
}));

test("invalid wake ceilings throw instead of applying defaults", async () => await withDirectory(async (directory) => {
  for (const value of ["0", "-1", "1.5", "abc"]) {
    await assert.rejects(WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: value }) }), /positive integer/);
  }
}));

test("off admits unconditionally without storage and every other setting is rejected", async () => await withDirectory(async (directory) => {
  const missing = path.join(directory, "missing");
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { warnings.push(values.join(" ")); };
  try {
    const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(missing, { DAIMON_WAKE_FUSE: "off", DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
    await WakeFuse.open({ organizationKey: "org", environment: environment(missing, { DAIMON_WAKE_FUSE: "off" }) });
    assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
    assert.deepEqual(await fuse.admit("alpha", "two"), { state: "admitted" });
  } finally { console.error = original; }
  assert.deepEqual(warnings, ["DAIMON WAKE FUSE IS OFF: wake admission is unbounded"]);
  await assert.rejects(WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE: "on" }) }), /exactly 'off'/);
}));

test("once tripped the fuse never admits again", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await fuse.admit("alpha", "one");
  assert.equal((await fuse.admit("alpha", "two")).state, "tripped");
  assert.equal((await fuse.admit("alpha", "one")).state, "tripped");
}));

test("a failed trip-marker write is retried without reopening admission", async () => await withProvisionedDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  await fuse.admit("alpha", "one");
  await mkdir(path.join(directory, "fuse.trip.json"));
  assert.deepEqual(await fuse.admit("alpha", "two"), { state: "tripped", reason: "wake_ceiling" });
  await rm(path.join(directory, "fuse.trip.json"), { recursive: true });
  assert.deepEqual(await fuse.admit("alpha", "three"), { state: "tripped", reason: "wake_ceiling" });
  const reopened = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_WAKES: "1" }) });
  assert.equal(reopened.tripped(), "wake_ceiling");
}));

/**
 * Defect 1: the production incident this covers is exactly a ledger that was
 * never created — `recordTurnUsage` swallows its own append failures, and
 * `sumTokens` treats a missing ledger as an empty one, so a broken
 * provisioning/permissions setup let a 17.6M-token run pass a 5M ceiling
 * untouched. An unenforceable ceiling (missing directory, or a present file
 * that cannot be read) must fail the organization's startup with a clear
 * message. A brand-new organization — directory provisioned, file simply
 * never written yet — must still be able to start: that is a true zero, not
 * an unknown one.
 */
test("a missing usage ledger directory refuses to arm the fuse", async () => await withDirectory(async (directory) => {
  // The wake-fuse directory itself exists (mkdtemp), but the ledger is
  // relocated under a subdirectory Spawnfile never provisioned.
  const neverProvisioned = path.join(directory, "not-provisioned", "usage.jsonl");
  await assert.rejects(
    WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_TURN_USAGE_LEDGER_PATH: neverProvisioned }) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /usage ledger/u);
      assert.match(error.message, /missing/u);
      assert.match(error.message, new RegExp(neverProvisioned.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      return true;
    }
  );
}));

test("a provisioned directory with no ledger file yet creates an empty ledger and arms", async () => await withDirectory(async (directory) => {
  const ledgerPath = path.join(directory, "usage.jsonl");
  // No usage.jsonl written: the directory (mkdtemp) stands in for Spawnfile's
  // provisioned, chowned volume; the file is what a fresh organization has
  // never written.
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory) });
  const created = await readFile(ledgerPath, "utf8");
  assert.equal(created, "");
  // Zero recorded spend is a true zero: nothing trips and the wake admits.
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("an unreadable usage ledger (a directory where the file should be) refuses to arm the fuse", async () => await withDirectory(async (directory) => {
  await mkdir(path.join(directory, "usage.jsonl"));
  await assert.rejects(
    WakeFuse.open({ organizationKey: "org", environment: environment(directory) }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /missing or unreadable/u);
      return true;
    }
  );
}));

test("DAIMON_WAKE_FUSE=off never touches the usage ledger, missing or not", async () => await withDirectory(async (directory) => {
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE: "off" }) });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("usage rows sharing a broker turn key count once toward the token ceiling", async () => await withDirectory(async (directory) => {
  const turn = "b".repeat(64);
  // 600 + 600 would trip a 1000-token ceiling; the duplicate turn row must not.
  await writeFile(path.join(directory, "usage.jsonl"), [
    JSON.stringify({ at: "2026-08-30T00:00:00.000Z", total: 600, turn }),
    JSON.stringify({ at: "2026-08-30T00:00:00.001Z", total: 600, turn })
  ].join("\n") + "\n");
  const now = () => new Date("2026-08-30T00:00:00.000Z");
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory), now });
  assert.deepEqual(await fuse.admit("alpha", "one"), { state: "admitted" });
}));

test("a long turn's cached reads weigh a tenth, so its retry is admitted and the ceiling still binds", async () => await withDirectory(async (directory) => {
  const now = () => new Date("2026-08-30T00:00:00.000Z");
  // The AGY turn of the 2026-11-14 pilot: 0.79M fresh input, 0.12M output, 27.7M cached reads in 236 steps.
  const turn = { at: "2026-08-30T00:00:00.000Z", agent: "alpha", input: 787_603, output: 115_613, cache_read: 27_673_646, total: 28_576_862 };
  await writeFile(path.join(directory, "usage.jsonl"), `${JSON.stringify(turn)}\n`);
  const fuse = await WakeFuse.open({ organizationKey: "org", environment: environment(directory, { DAIMON_WAKE_FUSE_MAX_TOKENS: "5000000", DAIMON_WAKE_FUSE_MAX_WAKES: "10" }), now });
  // Mutation guard: counted in full, this one turn read 28.6M against 5M and parked its own retry.
  assert.deepEqual(await fuse.admit("alpha", "retry"), { state: "admitted" });
  assert.equal(fuseTokens(turn), 787_603 + 115_613 + 2_767_365);
  // A second such turn passes the ceiling: cached reads are discounted, never free.
  await writeFile(path.join(directory, "usage.jsonl"), `${JSON.stringify(turn)}\n${JSON.stringify({ ...turn, at: "2026-08-30T00:00:00.001Z" })}\n`);
  assert.deepEqual(await fuse.admit("alpha", "third"), { state: "tripped", reason: "token_ceiling" });
  // A row with no cache accounting counts in full, and a cache figure above the total cannot go negative.
  assert.equal(fuseTokens({ total: 600 }), 600);
  assert.equal(fuseTokens({ total: 100, cache_read: 500 }), 10);
  assert.equal(fuseTokens({ total: -1, cache_read: 5 }), 0);
}));

// --- the counting window rolls itself -----------------------------------------

const unpinned = (directory: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const base = environment(directory, values);
  delete base.DAIMON_WAKE_FUSE_EPOCH;
  return base;
};

test("an unset epoch is derived from the day, so the budget renews without a deploy", async () => {
  await withProvisionedDirectory(async (directory) => {
    // THE BUG THIS PREVENTS: DAIMON_WAKE_FUSE_EPOCH comes from an env file, and
    // an env file applies at container CREATION only. Rolling it needed a
    // rebuild + recreate every morning. Stop deploying daily and the wake
    // ceiling never resets again.
    let clock = new Date("2026-09-23T23:59:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });

    assert.equal((await fuse.admit("agent:a", "d1")).state, "admitted");
    assert.equal((await fuse.admit("agent:b", "d2")).state, "admitted");
    // Ceiling is 2: the third is refused inside the same day.
    assert.deepEqual(await fuse.admit("agent:c", "d3"), { state: "tripped", reason: "wake_ceiling" });
    const spent = await fuse.snapshot("agent:a");
    assert.equal(spent.executions_remaining, 0);

    // Midnight passes. No redeploy, no restart, no env file, no reopen.
    clock = new Date("2026-09-24T00:01:00Z");
    assert.equal((await fuse.admit("agent:c", "d3")).state, "admitted", "a new day is a new budget");
    const fresh = await fuse.snapshot("agent:c");
    assert.notEqual(fresh.epoch, spent.epoch, "the window moved");
    assert.match(fresh.epoch, /-2026-09-24$/u);
    assert.equal(fresh.executions_used, 1, "yesterday's spend does not follow it across");
  });
});

test("the scheduler's budget gate renews at midnight on its own, before any admission", async () => {
  await withProvisionedDirectory(async (directory) => {
    // THE BUG THIS PREVENTS: AttentionDispatcher.drain() returns at
    // `snapshot().state !== "available"` and never reaches `admit()`. If only
    // admission rolled the day, a newsroom that hit its ceiling stayed paused
    // forever and needed a container restart every morning.
    // MUTATION CHECK: remove the roll from snapshot() and this goes red.
    let clock = new Date("2026-09-23T23:59:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    await fuse.admit("agent:a", "d1");
    await fuse.admit("agent:b", "d2");
    assert.deepEqual(await fuse.admit("agent:c", "d3"), { state: "tripped", reason: "wake_ceiling" });
    assert.equal((await fuse.snapshot("agent:c")).state, "paused");

    clock = new Date("2026-09-24T00:01:00Z");
    const gate = await fuse.snapshot("agent:c");
    assert.equal(gate.state, "available", "the gate the scheduler reads must see the new day");
    assert.match(gate.epoch, /-2026-09-24$/u);
    assert.equal(gate.executions_used, 0);
    assert.equal(fuse.tripped(), undefined, "yesterday's ceiling trip does not survive the roll");
  });
});

test("an explicitly pinned epoch is never rolled out from under the operator", async () => {
  await withProvisionedDirectory(async (directory) => {
    let clock = new Date("2026-09-23T23:59:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: environment(directory), now: () => clock });
    await fuse.admit("agent:a", "d1");
    await fuse.admit("agent:b", "d2");
    assert.deepEqual(await fuse.admit("agent:c", "d3"), { state: "tripped", reason: "wake_ceiling" });
    clock = new Date("2026-09-24T00:01:00Z");
    // Still tripped: pinning a window is a deliberate act and midnight does not undo it.
    assert.deepEqual(await fuse.admit("agent:c", "d3"), { state: "tripped", reason: "wake_ceiling" });
    assert.equal((await fuse.snapshot("agent:a")).epoch, "test-epoch");
  });
});

test("a new day renews a budget but never releases an operator stop", async () => {
  await withProvisionedDirectory(async (directory) => {
    let clock = new Date("2026-09-23T12:00:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    await writeFile(path.join(directory, "fuse.stop"), "operator stop\n");
    assert.deepEqual(await fuse.admit("agent:a", "d1"), { state: "tripped", reason: "operator_stop" });
    clock = new Date("2026-09-25T12:00:00Z");
    // MUTATION CHECK: scope the fuse.stop check to the epoch and this goes red.
    // A budget renews; a decision to stop does not.
    assert.deepEqual(await fuse.admit("agent:a", "d2"), { state: "tripped", reason: "operator_stop" },
      "a parked newsroom must stay parked across midnight");
  });
});

test("a clock that steps backward does not hand back a budget that was already spent", async () => {
  await withProvisionedDirectory(async (directory) => {
    let clock = new Date("2026-09-23T12:00:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    await fuse.admit("agent:a", "d1");
    await fuse.admit("agent:b", "d2");
    clock = new Date("2026-09-24T12:00:00Z");
    await fuse.admit("agent:c", "d3");
    // Back into the 23rd, whose two wakes are on the ledger.
    clock = new Date("2026-09-23T13:00:00Z");
    assert.deepEqual(await fuse.admit("agent:d", "d4"), { state: "tripped", reason: "wake_ceiling" },
      "admissions are rebuilt from the ledger, not emptied");
  });
});

test("a day means the operator's day, not the server's", async () => {
  await withProvisionedDirectory(async (directory) => {
    // 23:30 UTC on the 23rd is already the 24th in Berlin.
    const clock = new Date("2026-09-23T23:30:00Z");
    const utc = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    const berlin = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory, { DAIMON_WAKE_FUSE_EPOCH_ZONE: "Europe/Berlin" }), now: () => clock });
    assert.match((await utc.snapshot("agent:a")).epoch, /-2026-09-23$/u);
    assert.match((await berlin.snapshot("agent:a")).epoch, /-2026-09-24$/u);
  });
});

test("the derived window is stable across restarts within the same day", async () => {
  await withProvisionedDirectory(async (directory) => {
    const clock = new Date("2026-09-23T08:00:00Z");
    const first = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    await first.admit("agent:a", "d1");
    // A bare container restart reopens the fuse; the day has not changed, so
    // the spend must still be there.
    const second = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => new Date("2026-09-23T18:00:00Z") });
    const snapshot = await second.snapshot("agent:a");
    assert.equal(snapshot.epoch, (await first.snapshot("agent:a")).epoch);
    assert.equal(snapshot.executions_used, 1, "a restart is not a fresh budget");
  });
});

test("after a roll the budget snapshot agrees with what admission actually does", async () => {
  await withProvisionedDirectory(async (directory) => {
    // `admit` re-checks fuse.stop on its own, so a parked organization is
    // refused either way. `snapshot` has no such second check — it reads the
    // cached reason — so if the roll does not re-evaluate the stop, the
    // operator console reports "available" for a newsroom that refuses every
    // wake. Two answers to the same question is how a parked box looks healthy.
    let clock = new Date("2026-09-23T12:00:00Z");
    const fuse = await WakeFuse.open({ organizationKey: "clank", environment: unpinned(directory), now: () => clock });
    await writeFile(path.join(directory, "fuse.stop"), "operator stop\n");
    await fuse.admit("agent:a", "d1");
    clock = new Date("2026-09-25T12:00:00Z");
    assert.deepEqual(await fuse.admit("agent:a", "d2"), { state: "tripped", reason: "operator_stop" });
    const snapshot = await fuse.snapshot("agent:a");
    assert.equal(snapshot.state, "stopped", "the snapshot must not say available for a parked organization");
    assert.equal(snapshot.reason, "operator_stop");
  });
});
