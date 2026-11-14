/** Bytes of one stray line kept on the runtime log. */
export const STRAY_OUTPUT_LINE_MAX_BYTES = 2_048;
/** Stray lines of one turn written to the runtime log; the rest are counted. */
export const STRAY_OUTPUT_LINES_LOGGED = 32;

export type StrayOutputSink = (line: string) => void;

const logStrayLine: StrayOutputSink = (line) => { console.error(line); };

/**
 * The JSON frames of an engine's line protocol.
 *
 * An engine CLI owns its stdout, and a line that is not JSON is not a frame of
 * the protocol: a warning a library printed, a progress note, a download error.
 * It says nothing about whether the turn published, so it is never a failure by
 * itself. It is kept, bounded, on the runtime log as a diagnostic, and the
 * frames around it decide the turn exactly as they would have without it. A
 * turn with no usable terminal frame still fails on that, in the decoder's own
 * words.
 */
export const parseProtocolLines = (engine: string, output: string, onStray: StrayOutputSink = logStrayLine): unknown[] => {
  const frames: unknown[] = [];
  let stray = 0;
  for (const line of output.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try { frames.push(JSON.parse(line)); continue; } catch { /* not a protocol frame */ }
    if (++stray > STRAY_OUTPUT_LINES_LOGGED) continue;
    const bytes = Buffer.from(line, "utf8");
    const kept = bytes.length > STRAY_OUTPUT_LINE_MAX_BYTES ? `${bytes.subarray(0, STRAY_OUTPUT_LINE_MAX_BYTES).toString("utf8")} [… ${bytes.length - STRAY_OUTPUT_LINE_MAX_BYTES} bytes elided …]` : line;
    onStray(`daimon: engine stdout engine=${engine} line outside its JSON protocol | ${kept}`);
  }
  if (stray > STRAY_OUTPUT_LINES_LOGGED) onStray(`daimon: engine stdout engine=${engine} ${stray - STRAY_OUTPUT_LINES_LOGGED} more lines outside its JSON protocol not shown`);
  return frames;
};
