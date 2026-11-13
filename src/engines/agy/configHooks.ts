import { parseTurnTimeoutMs, type ConfigEngineHooks } from "../configHooks.js";

export const agyConfigHooks: ConfigEngineHooks = {
  parseConfig(input, label) {
    const allowed = ["kind", "turnTimeoutMs"];
    const extras = Object.keys(input).filter((key) => !allowed.includes(key));
    if (extras.includes("model") || extras.includes("reasoningEffort") || extras.includes("codexSandbox")) {
      throw new TypeError(`${label}.model, ${label}.reasoningEffort, and ${label}.codexSandbox are codex-only for agy; its subscription auth, model selection, and sandbox policy are Daimon-owned`);
    }
    if (extras.length > 0) throw new TypeError(`${label} must contain exactly ${allowed.join(", ")}`);
    return { kind: "agy", ...(input.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: parseTurnTimeoutMs(input.turnTimeoutMs, `${label}.turnTimeoutMs`) }) };
  }
};
