/**
 * What a token read back from a provider's cache weighs against a token ceiling, beside a fresh one: a tenth,
 * the cached-input rate providers publish. One figure for every ceiling Daimon enforces (a wake's own, an
 * agent's, the organization's), so the same turn never counts differently in two places.
 */
export const CACHED_READ_TOKEN_WEIGHT = 0.1;
