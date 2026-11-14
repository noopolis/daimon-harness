import { redactCredentialText } from "../core/credentialRedaction.js";

/** A stderr stretch with no line end is written once it reaches this size, so memory stays bounded. */
export const CLI_STDERR_LOG_MAX_LINE_BYTES = 64 * 1024;

/**
 * The whole stderr of a CLI engine child, forwarded to the runtime's own
 * stderr as it arrives: every line, credentials redacted, prefixed so the
 * lines of concurrent wakes stay attributable.
 *
 * A failed wake's error keeps only a bounded head and tail of this stream
 * (`CLI_ENGINE_MAX_DIAGNOSTIC_BYTES`), which is enough to label a failure and
 * not enough to diagnose one. The runtime's stderr is the log its operator
 * already keeps, so the full account lands there and nothing new is stored.
 */
export const createCliStderrLog = (
  label: string,
  secretValues: readonly string[],
  write: (text: string) => void = (text) => { process.stderr.write(text); }
): Readonly<{ observe(chunk: Buffer): void; finish(): void }> => {
  let held = "";
  const secrets = secretValues.filter((secret) => secret.length > 0);
  const emit = (line: string): void => {
    const text = redactCredentialText(line.replace(/\r$/u, ""), secrets, Number.MAX_SAFE_INTEGER);
    if (text.length > 0) write(`daimon: engine stderr ${label} | ${text}\n`);
  };
  /** The longest end of `text` that could be the start of a secret still arriving: held back so no secret is cut in two. */
  const pendingSecret = (text: string): number => {
    let longest = 0;
    for (const secret of secrets) {
      for (let length = Math.min(text.length, secret.length - 1); length > longest; length--) {
        if (text.endsWith(secret.slice(0, length))) { longest = length; break; }
      }
    }
    return longest;
  };
  return {
    observe(chunk) {
      held += chunk.toString("utf8");
      const lines = held.split("\n");
      held = lines.pop()!;
      for (const line of lines) emit(line);
      if (Buffer.byteLength(held, "utf8") > CLI_STDERR_LOG_MAX_LINE_BYTES) {
        const cut = held.length - pendingSecret(held);
        emit(held.slice(0, cut));
        held = held.slice(cut);
      }
    },
    finish() {
      emit(held);
      held = "";
    }
  };
};
