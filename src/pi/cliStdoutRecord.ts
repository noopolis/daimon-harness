import { createWriteStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ENGINE_OUTPUT_RECORD_DIRECTORY } from "../engines/descriptorContracts.js";
import { ensureRuntimeHomeDirectory } from "../runtime/runtimeHomeLayout.js";
import { createRedactedLineStream } from "./cliStderrLog.js";

/** Records kept per agent: the newest wakes, so a durable home never grows without bound. */
export const ENGINE_OUTPUT_RECORDS_KEPT = 8;
/** Bytes one wake's record may hold; a record that reaches it ends with a line saying so. */
export const ENGINE_OUTPUT_RECORD_MAX_BYTES = 64 * 1024 * 1024;
const SUFFIX = ".stdout.jsonl";

export interface EngineOutputRecord { observe(chunk: Buffer): void; finish(): Promise<void> }
const NO_RECORD: EngineOutputRecord = { observe: () => undefined, finish: async () => undefined };

/**
 * One wake's whole engine stdout, as the engine wrote it, credentials redacted.
 *
 * Stdout is the protocol Daimon decodes a turn from, and what it retains of it
 * is bounded and shaped for that decoding (a reply cap, for AGY only its
 * metered frames). When a turn fails on what the engine printed, the printed
 * bytes are the evidence, and they were gone with the child. This keeps them
 * in the agent's own runtime home, where a consumer that keeps a run's evidence
 * collects them through the descriptor's `diagnostics.paths`.
 *
 * Advisory by construction: a record that cannot be opened or written is
 * skipped and never fails or delays a turn.
 */
export const openEngineOutputRecord = async (
  runtimeHomePath: string | undefined,
  engine: string,
  wakeId: string | undefined,
  secretValues: readonly string[],
  limits: Readonly<{ kept?: number; maxBytes?: number }> = {}
): Promise<EngineOutputRecord> => {
  if (runtimeHomePath === undefined) return NO_RECORD;
  try {
    const directory = await ensureRuntimeHomeDirectory(runtimeHomePath, ENGINE_OUTPUT_RECORD_DIRECTORY);
    const kept = limits.kept ?? ENGINE_OUTPUT_RECORDS_KEPT;
    const maxBytes = limits.maxBytes ?? ENGINE_OUTPUT_RECORD_MAX_BYTES;
    const existing = await Promise.all((await readdir(directory)).filter((name) => name.endsWith(SUFFIX))
      .map(async (name) => ({ name, at: (await stat(path.join(directory, name))).mtimeMs })));
    for (const old of existing.sort((left, right) => right.at - left.at || right.name.localeCompare(left.name)).slice(Math.max(0, kept - 1))) {
      await rm(path.join(directory, old.name), { force: true });
    }
    const name = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${(wakeId ?? "wake").replace(/[^A-Za-z0-9_-]+/gu, "_").slice(0, 80)}.${engine}${SUFFIX}`;
    const file = createWriteStream(path.join(directory, name), { flags: "wx", mode: 0o600 });
    let failed = false;
    file.on("error", () => { failed = true; });
    let bytes = 0;
    let full = false;
    const lines = createRedactedLineStream(secretValues, (line) => {
      if (failed || full) return;
      const record = Buffer.from(`${line}\n`, "utf8");
      if (bytes + record.length > maxBytes) {
        full = true;
        file.write(`${JSON.stringify({ daimon: "engine output record bound reached", bound_bytes: maxBytes })}\n`);
        return;
      }
      bytes += record.length;
      file.write(record);
    });
    return {
      observe: (chunk) => { if (!failed && !full) lines.observe(chunk); },
      finish: () => new Promise((resolve) => {
        lines.finish();
        if (failed) { resolve(); return; }
        file.once("error", () => resolve());
        file.end(() => resolve());
      })
    };
  } catch { return NO_RECORD; }
};
