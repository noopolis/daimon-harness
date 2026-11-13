import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import { GROK_BROKER_MODELS, GROK_BROKER_REASONING_EFFORTS } from "./broker/grokWorkerContract.js";

/** The released schema's closed broker pair, declared together. */
export const GROK_CONFIG_CONDITION = {
  if: { properties: { kind: { const: "grok" } } },
  then: { properties: { model: { enum: GROK_BROKER_MODELS }, reasoningEffort: { enum: GROK_BROKER_REASONING_EFFORTS }, codexSandbox: false, turnTimeoutMs: false }, dependentRequired: ENGINE_DESCRIPTORS.grok.modelSelection.requiresPairedDeclaration ? { model: ["reasoningEffort"], reasoningEffort: ["model"] } : {} }
} as const;
