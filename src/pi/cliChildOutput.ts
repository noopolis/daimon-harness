import type { ChildProcess } from "node:child_process";

import { redactCredentialText } from "../core/credentialRedaction.js";
import { headUtf8, tailUtf8 } from "../runtime/toolResultSpill.js";
import type { TurnUsageFailureReason } from "../runtime/turnUsageLedger.js";
import type { CodexChildOutputOptions } from "../engines/codex/piOutput.js";
import { getEngineHandler } from "../engines/registry.js";
import { terminateChild, trackCliChild } from "./cliProcess.js";

/** Maximum assistant reply bytes retained from stdout. */
export const CLI_ENGINE_MAX_OUTPUT_BYTES = 64 * 1024;
/** Diagnostic bytes retained from stderr for a failed child: its head and its tail together. */
export const CLI_ENGINE_MAX_DIAGNOSTIC_BYTES = 768;
const CLI_ENGINE_FAILURE_SCAN_CHARS = 256;

/**
 * Which bound or condition failed a wake, carried on the error object itself.
 *
 * The caller needs this to label the usage row a failed wake still owes the
 * ledger, and matching on the message text would make that label depend on
 * prose. The tag is a non-enumerable symbol property, so it never widens the
 * error's serialized form and never reaches a diagnostic string.
 */
const CLI_CHILD_FAILURE_REASON = Symbol("daimon.cliChildFailureReason");

export const tagCliChildFailure = <T>(error: T, reason: TurnUsageFailureReason): T => {
  if (!(error instanceof Error)) return error;
  // Labelling a failure must never become a second failure: a frozen or sealed
  // error simply goes untagged and its row reads `unknown`.
  try { Object.defineProperty(error, CLI_CHILD_FAILURE_REASON, { configurable: true, enumerable: false, value: reason, writable: true }); }
  catch { /* the reason is advisory; the failure it describes is not */ }
  return error;
};

export const cliChildFailureReason = (error: unknown): TurnUsageFailureReason | undefined =>
  error instanceof Error
    ? (error as Error & { [CLI_CHILD_FAILURE_REASON]?: TurnUsageFailureReason })[CLI_CHILD_FAILURE_REASON]
    : undefined;

const redactChildOutput = (value: string, secretValues: readonly string[]): string => {
  return redactCredentialText(value, secretValues, CLI_ENGINE_MAX_OUTPUT_BYTES);
};

/**
 * One bounded window over a failed child's own output: its head AND its tail,
 * with an explicit marker naming the bytes elided between them.
 *
 * A pure tail is the wrong end for the process this exists for. A worker that
 * dies early prints its error first and then echoes its own input, so the tail
 * is the echo: one live brokered turn reported 512 bytes of its own prompt
 * read back, with the actual error already off the front and discarded. Both
 * ends cost the same window, and the marker is the one oversized tool results
 * already use (`toolResultSpill.ts`), so a reader meets one shape everywhere.
 *
 * The marker is paid for out of the same budget — it is sized against the
 * largest count it could carry — so the result never exceeds `maxBytes`, and
 * output that fits is returned byte-identical with no marker at all.
 */
export const boundedDiagnosticWindow = (value: string, maxBytes: number): string => {
  const total = Buffer.byteLength(value, "utf8");
  if (total <= maxBytes) return value;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(elisionMarker(total), "utf8"));
  const head = headUtf8(value, Math.floor(budget / 2));
  const tail = tailUtf8(value, budget - Buffer.byteLength(head, "utf8"));
  const elided = total - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `${head}${elisionMarker(elided)}${tail}`;
};
const elisionMarker = (elided: number): string => `[… ${elided} bytes elided …]`;

const childDiagnostic = (stdout: string, stderr: string, secretValues: readonly string[]): string => {
  const output = stderr.trim().length > 0 ? stderr : stdout;
  const redacted = redactCredentialText(output, secretValues, Number.MAX_SAFE_INTEGER).trim();
  const bounded = boundedDiagnosticWindow(redacted, CLI_ENGINE_MAX_DIAGNOSTIC_BYTES).trim();
  return bounded.length > 0 ? `: ${bounded}` : "";
};

export const readChild = (
  child: ChildProcess,
  timeoutMs: number | undefined,
  secretValues: readonly string[],
  options: Readonly<{
    failureClassifier?: (diagnostic: string) => Error | undefined;
    retainStdoutTail?: boolean;
    /** Overrides the generic wall-clock-timeout message so the caller can name which bound was hit. */
    timeoutErrorMessage?: string;
    /** Every stdout chunk as it arrives, before retention; for an engine meter that must outlive a killed child. */
    onStdoutData?: (chunk: Buffer) => void;
    /** Every stderr chunk as it arrives, whole: the failure diagnostic below keeps only a bounded head and tail of it. */
    onStderrData?: (chunk: Buffer) => void;
  }> & CodexChildOutputOptions = {}
): Promise<string> => new Promise((resolve, reject) => {
  trackCliChild(child);
  const stdout: Buffer[] = [];
  let stdoutTail = Buffer.alloc(0);
  let droppingStdoutLine = false;
  // Both ends of stderr, retained as it streams: the head frozen once it is
  // full, the tail sliding. A single sliding tail dropped the head at capture
  // time, which is where the cause of an early death lives — no later window
  // can recover what was never kept.
  let stderrHead = Buffer.alloc(0);
  let stderrTail = Buffer.alloc(0);
  let stderrBytes = 0;
  let stdoutBytes = 0;
  let settled = false;
  let cleanupStarted = false;
  let classifiedFailure: Error | undefined;
  let failureScanTail = "";
  /**
   * Each retained end carries its reported share PLUS one whole secret, which
   * is the invariant that keeps exact redaction exact: a secret that reaches
   * the reported window can extend at most its own length past that window's
   * cut, so retaining that much more on each side means the redactor always
   * sees the secret whole. Halving one shared budget instead broke it — a
   * 2000-byte secret was cut in the middle and its tail fragment
   * (`…qqq-secret-end`) reached the diagnostic verbatim.
   */
  const stderrSecretAllowance = Math.max(0, ...secretValues.map((secret) => Buffer.byteLength(secret, "utf8")));
  const stderrHeadBytes = Math.floor(CLI_ENGINE_MAX_DIAGNOSTIC_BYTES / 2) + stderrSecretAllowance;
  const stderrTailBytes = CLI_ENGINE_MAX_DIAGNOSTIC_BYTES - Math.floor(CLI_ENGINE_MAX_DIAGNOSTIC_BYTES / 2) + stderrSecretAllowance;
  const settle = (action: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    action();
  };
  const abort = (error: Error): void => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void terminateChild(child).then(
      () => settle(() => reject(error)),
      (cleanupError: unknown) => settle(() => reject(cleanupError instanceof Error ? cleanupError : error))
    );
  };
  const outputRetention = options.retainNdjson === undefined ? undefined
    : getEngineHandler(options.retainNdjson).createOutputRetention?.(options, stdout, CLI_ENGINE_MAX_OUTPUT_BYTES, abort);
  const classifyFailure = (chunk: Buffer): void => {
    if (classifiedFailure !== undefined || options.failureClassifier === undefined) return;
    const diagnostic = `${failureScanTail}${chunk.toString("utf8")}`;
    classifiedFailure = options.failureClassifier(diagnostic);
    failureScanTail = diagnostic.slice(-CLI_ENGINE_FAILURE_SCAN_CHARS);
  };
  const retainStdout = (chunk: Buffer): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    classifyFailure(value);
    try { options.onStdoutData?.(value); } catch { /* advisory metering never fails the turn */ }
    if (outputRetention !== undefined) { outputRetention.retain(value); return; }
    if (options.retainStdoutTail === true) {
      let remainder = value;
      if (droppingStdoutLine) {
        const newline = remainder.indexOf(0x0a);
        if (newline < 0) return;
        droppingStdoutLine = false;
        remainder = remainder.subarray(newline + 1);
      }
      const combined = Buffer.concat([stdoutTail, remainder]);
      if (combined.length <= CLI_ENGINE_MAX_OUTPUT_BYTES) {
        stdoutTail = combined;
        return;
      }
      const overflow = combined.length - CLI_ENGINE_MAX_OUTPUT_BYTES;
      if (combined[overflow - 1] === 0x0a) {
        stdoutTail = Buffer.from(combined.subarray(overflow));
        return;
      }
      const newline = combined.indexOf(0x0a, overflow);
      stdoutTail = newline < 0 ? Buffer.alloc(0) : Buffer.from(combined.subarray(newline + 1));
      droppingStdoutLine = newline < 0;
      return;
    }
    stdoutBytes += value.length;
    if (stdoutBytes > CLI_ENGINE_MAX_OUTPUT_BYTES) {
      abort(tagCliChildFailure(new Error(`CLI engine output exceeded ${CLI_ENGINE_MAX_OUTPUT_BYTES} bytes`), "output_limit"));
      return;
    }
    stdout.push(value);
  };
  const retainStderrWindow = (chunk: Buffer): void => {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    options.onStderrData?.(value);
    classifyFailure(value);
    stderrBytes += value.length;
    if (stderrHead.length < stderrHeadBytes) stderrHead = Buffer.concat([stderrHead, value.subarray(0, stderrHeadBytes - stderrHead.length)]);
    if (value.length >= stderrTailBytes) {
      stderrTail = Buffer.from(value.subarray(value.length - stderrTailBytes));
      return;
    }
    const overflow = stderrTail.length + value.length - stderrTailBytes;
    stderrTail = Buffer.concat([overflow > 0 ? stderrTail.subarray(overflow) : stderrTail, value]);
  };
  /**
   * The retained stderr, reassembled exactly.
   *
   * Nothing was elided while the whole output fitted the budget, and then the
   * two ends overlap: they tile the stream, so dropping the overlap from the
   * tail rebuilds it byte-identically. Above the budget the ends are joined by
   * the marker, which names how many bytes never reached this process at all.
   */
  const retainedStderr = (): string => {
    const elided = stderrBytes - stderrHead.length - stderrTail.length;
    if (elided <= 0) return Buffer.concat([stderrHead, stderrTail.subarray(stderrHead.length + stderrTail.length - stderrBytes)]).toString("utf8");
    return `${stderrHead.toString("utf8")}${elisionMarker(elided)}${stderrTail.toString("utf8")}`;
  };
  child.stdout?.on("data", retainStdout);
  child.stderr?.on("data", retainStderrWindow);
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort(tagCliChildFailure(new Error(options.timeoutErrorMessage ?? "CLI engine timed out"), "wake_timeout")), timeoutMs);
  child.once("error", abort);
  child.once("close", (code, signal) => {
    if (cleanupStarted) return;
    outputRetention?.finish();
    const retainedStdout = options.retainStdoutTail === true ? stdoutTail : Buffer.concat(stdout);
    if (code === 0) {
      settle(() => resolve(redactChildOutput(retainedStdout.toString("utf8"), secretValues).trim()));
      return;
    }
    settle(() => reject(tagCliChildFailure(classifiedFailure ?? new Error(`CLI engine exited ${code ?? signal}${childDiagnostic(
      retainedStdout.toString("utf8"), retainedStderr(), secretValues
    )}`), "engine_exit")));
  });
});
