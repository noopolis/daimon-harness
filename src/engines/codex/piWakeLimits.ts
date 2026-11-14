/**
 * Per-wake engine bounds, and the one place they are decided.
 *
 * `maxToolTurns` mediates only daimon-MCP tool calls; Codex's own shell
 * (`exec_command`) is never routed through that gate, so a single Codex turn
 * previously had no ceiling at all — one production wake ran 23:32→23:42
 * (unbounded wall clock) making 51 shell calls. Codex's `--json` stream
 * reports token usage exactly once, on `turn.completed` — there is no
 * incremental total to watch mid-turn (verified against a live multi-tool-call
 * turn: `item.completed` fires once per tool call, but usage is reported only
 * on the single terminal `turn.completed`) — so the token ceiling is the best
 * bound obtainable from that wire shape: it converts an over-budget turn into
 * an explicit, killed, named failure instead of a silent success, and the
 * wall-clock timeout is what actually interrupts a runaway turn in progress.
 *
 * The names are engine-neutral: `DAIMON_ENGINE_WAKE_TIMEOUT_MS` and
 * `DAIMON_ENGINE_WAKE_TOKEN_CEILING` bound Codex locally and are passed to the
 * Grok broker as the wake's *lowering* limits (the broker refuses a value above
 * its registration). The `DAIMON_CODEX_*` names remain aliases; setting both
 * names of one bound to different values is refused rather than guessed.
 */
export const DEFAULT_CODEX_WAKE_TIMEOUT_MS = 240_000;
export const DEFAULT_CODEX_WAKE_TOKEN_CEILING = 300_000;
/**
 * The weight a cached prompt read carries against the token ceiling.
 *
 * The ceiling bounds spend, and a cached read is billed at a tenth of a fresh
 * input token (OpenAI's published cached-input rate for the GPT-5 family).
 * Codex reports one cumulative usage per turn, so a tool-using turn counts its
 * whole conversation again on every model request, about 90% of it from cache.
 * Counted in full, the ceiling was a context-size limit: eight training turns in
 * a row (410k to 1.03M reported, 46k to 76k of it fresh) filed their work and
 * were then failed at the 300k default. Fresh input and output still count in
 * full, as in the Grok broker's meter; the usage ledger keeps raw counts.
 */
export const CODEX_CACHED_INPUT_TOKEN_WEIGHT = 0.1;
/** What a turn's reported usage costs against the per-wake token ceiling. */
export const codexCeilingTokens = (usage: Readonly<{ total: number; cacheRead: number }>): number => {
  const cached = Math.min(usage.cacheRead, usage.total);
  return usage.total - cached + Math.ceil(cached * CODEX_CACHED_INPUT_TOKEN_WEIGHT);
};
export const DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV = "DAIMON_ENGINE_WAKE_TIMEOUT_MS";
export const DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV = "DAIMON_ENGINE_WAKE_TOKEN_CEILING";
export const DAIMON_CODEX_WAKE_TIMEOUT_MS_ENV = "DAIMON_CODEX_WAKE_TIMEOUT_MS";
export const DAIMON_CODEX_WAKE_TOKEN_CEILING_ENV = "DAIMON_CODEX_WAKE_TOKEN_CEILING";

const positiveInteger = (value: string, name: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const declared = (environment: NodeJS.ProcessEnv, neutral: string, alias: string): number | undefined => {
  const primary = environment[neutral], legacy = environment[alias];
  const value = primary === undefined ? undefined : positiveInteger(primary, neutral);
  const aliased = legacy === undefined ? undefined : positiveInteger(legacy, alias);
  if (value !== undefined && aliased !== undefined && value !== aliased) throw new Error(`${neutral} and ${alias} disagree; set one`);
  return value ?? aliased;
};

export const resolveCodexWakeTimeoutMs = (environment: NodeJS.ProcessEnv = process.env): number =>
  declared(environment, DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV, DAIMON_CODEX_WAKE_TIMEOUT_MS_ENV) ?? DEFAULT_CODEX_WAKE_TIMEOUT_MS;
export const resolveCodexWakeTokenCeiling = (environment: NodeJS.ProcessEnv = process.env): number =>
  declared(environment, DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV, DAIMON_CODEX_WAKE_TOKEN_CEILING_ENV) ?? DEFAULT_CODEX_WAKE_TOKEN_CEILING;

/**
 * The limits a wake asks a broker to lower to: only the bounds the operator
 * actually set, never the Codex defaults (a broker registration's declared
 * limits already are the defaults there).
 */
export const resolveEngineWakeLimitOverrides = (environment: NodeJS.ProcessEnv = process.env): Readonly<{ timeoutMs?: number; maxTokens?: number }> | undefined => {
  const timeoutMs = declared(environment, DAIMON_ENGINE_WAKE_TIMEOUT_MS_ENV, DAIMON_CODEX_WAKE_TIMEOUT_MS_ENV);
  const maxTokens = declared(environment, DAIMON_ENGINE_WAKE_TOKEN_CEILING_ENV, DAIMON_CODEX_WAKE_TOKEN_CEILING_ENV);
  if (timeoutMs === undefined && maxTokens === undefined) return undefined;
  return { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(maxTokens === undefined ? {} : { maxTokens }) };
};
