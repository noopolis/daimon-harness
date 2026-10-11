import {
  createExtensionRuntime,
  type ResourceLoader
} from "@earendil-works/pi-coding-agent";
import {
  getMemorySkillTextForMode,
  type MemoryWakeMode
} from "@noopolis/mneme";

import type { AgentStartInput, WakeEvent } from "../core/types.js";

export const formatWakePrompt = (event: WakeEvent): string => `Wake event:
- id: ${event.id}
- kind: ${event.kind}
- from: ${event.from === undefined ? "[no attribution supplied] (absence)" : JSON.stringify(event.from)}

${event.text}`;

const WAKE_HEADER_PATTERN = /(^|\r?\n)## Wake\r?\nid: ([^\r\n]*)(?=\r?\n|$)/u;

const formatAuthoritativeWakeIdentity = (event: WakeEvent): string => [
  "Wake identity:",
  "Use this exact wake id as the delivery id/event key when a tool asks for event_key.",
  `- id: ${event.id}`,
  `- kind: ${event.kind}`,
  `- from: ${event.from === undefined ? "[no attribution supplied] (absence)" : JSON.stringify(event.from)}`
].join("\n");

export const preserveModelFacingWakeIdentity = (
  promptText: string,
  event: WakeEvent,
  memoryEventId: string
): string => {
  if (event.id === memoryEventId) return promptText;

  const match = WAKE_HEADER_PATTERN.exec(promptText);
  if (match === null) {
    return `${formatAuthoritativeWakeIdentity(event)}\n\n${promptText}`;
  }

  const currentId = match[2];
  if (currentId === event.id) return promptText;

  if (currentId !== memoryEventId) {
    throw new Error("memory-prepared wake prompt carried an unexpected wake id");
  }

  const idStart = match.index + match[0].length - currentId.length;
  return `${promptText.slice(0, idStart)}${event.id}${promptText.slice(idStart + currentId.length)}`;
};

export const createResourceLoader = (
  input: AgentStartInput,
  mode: MemoryWakeMode,
  capabilities: Readonly<{ memory: boolean; world: boolean }>
): ResourceLoader => {
  const systemPrompt = [
    `You are ${input.name} (${input.id}).`,
    input.instructions,
    "You are running inside a harnessed workspace prepared by the caller.",
    ...(input.tools === undefined || input.tools.length > 0
      ? [
        "Use the available coding tools when asked to read, write, edit, or inspect files.",
        "Keep responses brief and report the exact files you created or modified."
      ]
      : []),
    ...(capabilities.memory ? [getMemorySkillTextForMode(mode)] : []),
    ...(capabilities.world
      ? [
        "Use only the authenticated world tools and standing instructions to perceive and act. "
        + "The harness binds wake authority and request identity; choose only the sense, affordance, target, and typed action input exposed by tool schemas."
      ]
      : [])
  ].filter((section) => section.length > 0).join("\n\n");

  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
};
