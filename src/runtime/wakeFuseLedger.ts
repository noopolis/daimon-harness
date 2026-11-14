import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";

import { TURN_USAGE_LEDGER } from "./turnUsageLedger.js";

/** What a token read back from the provider's cache weighs against a fuse ceiling, beside a fresh one. */
export const CACHED_READ_FUSE_WEIGHT = 0.1;

/**
 * The tokens one usage row spends against a fuse ceiling: everything the model
 * processed fresh (input not served from cache, output) in full, and cached
 * reads at a tenth.
 *
 * A multi-step turn re-reads its whole context from cache on every step, so its
 * cached reads grow with the square of its length: one 236-step AGY turn that
 * read 0.8M fresh tokens and wrote 0.1M reported 27.7M cached reads. Counted in
 * full, that single turn passed a 5M organization ceiling five times over and
 * parked its own retry, on tokens the provider serves at about a tenth of the
 * price. Counted at zero, a loop over a fully cached context would never meet
 * the ceiling at all. A tenth keeps the ceiling a real bound on both.
 *
 * Every engine's row `total` already includes its cached reads (as part of
 * `input` or beside it), so the weight is taken off the total. A row without
 * `cache_read` counts in full, as before.
 */
export const fuseTokens = (row: { total?: unknown; cache_read?: unknown }): number => {
  if (typeof row.total !== "number" || !Number.isFinite(row.total) || row.total < 0) return 0;
  const cached = typeof row.cache_read === "number" && Number.isFinite(row.cache_read) && row.cache_read > 0 ? Math.min(row.cache_read, row.total) : 0;
  return Math.ceil(row.total - cached * (1 - CACHED_READ_FUSE_WEIGHT));
};

/** Usage-ledger reads the wake fuse depends on; split out of `wakeFuse.ts` for its size bound. */
export async function sumTokens(ledgerPath: string, since: string, agentId?: string): Promise<number> {
  let total = 0;
  // Rows carrying a `turn` idempotency key count once per turn, whichever file holds them.
  const turns = new Set<string>();
  for (const file of [`${ledgerPath}.1`, ledgerPath]) {
    for (const line of await lines(file)) {
      try {
        const value = JSON.parse(line) as { at?: unknown; total?: unknown; cache_read?: unknown; agent?: unknown; turn?: unknown; kind?: unknown };
        // Evaluator inference rows belong to their own ledger; one here (a misconfigured path) is never subject spend.
        if (value.kind === "inference") continue;
        if (typeof value.turn === "string") { if (turns.has(value.turn)) continue; turns.add(value.turn); }
        if ((agentId === undefined || value.agent === agentId) && typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) && value.at >= since) total += fuseTokens(value);
      } catch { /* usage accounting is advisory input; malformed lines are skipped */ }
    }
  }
  return total;
}

export async function lines(file: string): Promise<string[]> { try { return (await readFile(file, "utf8")).split("\n").filter(Boolean); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; } }

/**
 * An unenforceable usage ledger at arm time must never degrade to a silent
 * zero. `sumTokens` (used on every later `admit`) deliberately treats a
 * missing ledger as an empty one — if the ledger is deleted mid-epoch, the
 * fuse still needs to keep functioning rather than wedge the organization —
 * but that same tolerance is exactly how a 17.6M-token run passed a 5M
 * ceiling untouched: the ledger was never created at all, so every sum read
 * zero and the ceiling never had anything to compare against.
 *
 * Four states, distinguished by what actually makes the ceiling
 * unenforceable versus merely unwritten yet:
 *  - The ledger directory is missing, or present but not writable by this
 *    uid: the ceiling is genuinely unenforceable. Fails loudly, the same
 *    treatment `readdir(directory)` above already gives a missing
 *    admissions directory.
 *  - The directory is present and writable but the ledger file itself is
 *    absent: Spawnfile's entrypoint provisions and chows the directory as a
 *    persistent volume before the first turn ever writes usage
 *    (`renderDaimonUsageLedgerProvisioning`), so a brand-new organization
 *    legitimately has zero recorded spend. That is a true zero, not an
 *    unknown one — but only once this durably creates the (empty) ledger
 *    itself and verifies the result is readable, rather than assuming a
 *    missing file means zero.
 *  - The ledger file exists and is readable: arm normally; `sumTokens` sums
 *    whatever is in it.
 *  - The ledger file exists but is unreadable (EACCES, EISDIR, ...): fails
 *    loudly, exactly as before.
 */
export async function ensureUsageLedgerUsable(ledgerPath: string): Promise<void> {
  try {
    await readFile(ledgerPath, "utf8");
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`DAIMON_WAKE_FUSE cannot start: usage ledger at ${ledgerPath} is missing or unreadable (${code ?? String(error)}); refusing to admit wakes against an unenforceable token ceiling`);
    }
  }

  // Ledger file absent. Create it empty, matching the mode the broker itself
  // writes usage records with, so a fresh organization can start.
  try {
    const handle = await open(ledgerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, TURN_USAGE_LEDGER.fileMode);
    await handle.close();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EEXIST means a concurrent writer created it first (e.g. a racing turn
    // append); that is not a creation failure, so fall through to verify.
    if (code !== "EEXIST") {
      throw new Error(`DAIMON_WAKE_FUSE cannot start: usage ledger at ${ledgerPath} is missing and could not be created (${code ?? String(error)}); refusing to admit wakes against an unenforceable token ceiling`);
    }
  }

  // Never assume the create succeeded: read the file back before treating
  // the ceiling as enforceable.
  try { await readFile(ledgerPath, "utf8"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new Error(`DAIMON_WAKE_FUSE cannot start: usage ledger at ${ledgerPath} is missing or unreadable (${code}); refusing to admit wakes against an unenforceable token ceiling`);
  }
}
