import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WakeEvent } from "../core/types.js";
import { createClockedMemoryRuntime } from "../pi/memoryClock.js";
import { withTaskClockPrompt } from "../pi/prompts.js";
import type { MemoryRecallAudit, MemoryRuntime } from "@noopolis/mneme";
import { runEngineDetailed, type CliEngineKind as EngineKind, type EngineRunResult } from "../pi/cliSession.js";

export interface JungianVoiceConfig {
  archetype?: string;
  engine: EngineKind;
  id: string;
  instructions: string[];
  name: string;
  runtimeRoot: string;
  selfId: string;
  selfName: string;
}

export interface JungianVoiceTurn {
  engineResult: EngineRunResult;
  event: WakeEvent;
  memoryPrepareMs: number;
  memoryRecordMs: number;
  outputText: string;
  promptText: string;
  recall: MemoryRecallAudit;
  totalMs: number;
  voice: JungianVoiceConfig;
}

const maxMemoryChars = 2200;

const truncate = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}\n[truncated]`;

const memorySections = (turnPrompt: string): string =>
  truncate(turnPrompt, maxMemoryChars);

export class JungianVoice {
  readonly runtimeHomePath: string;
  readonly workspacePath: string;
  private readonly memory: MemoryRuntime;

  constructor(readonly config: JungianVoiceConfig) {
    this.workspacePath = path.join(config.runtimeRoot, "selves", config.selfId, "voices", config.id, "workspace");
    this.runtimeHomePath = path.join(config.runtimeRoot, "selves", config.selfId, "voices", config.id, "runtime");
    this.memory = createClockedMemoryRuntime({
      agentId: config.id,
      runtimeHomePath: this.runtimeHomePath,
      source: `daimon/jungian-play/${config.engine}`,
      tokenBudget: 2600
    });
  }

  async prepare(): Promise<void> {
    await mkdir(this.workspacePath, { recursive: true });
    await mkdir(this.runtimeHomePath, { recursive: true });
    await writeFile(
      path.join(this.workspacePath, "AGENTS.md"),
      [
        `# ${this.config.name}`,
        "",
        `Self: ${this.config.selfName}`,
        `Voice: ${this.config.archetype ?? "Representative Self"}`,
        `Engine: ${this.config.engine}`,
        "",
        "This workspace belongs to the Daimon Jungian play E2E.",
        "Do not edit files during the play. Speak only through the requested output shape."
      ].join("\n")
    );
  }

  async stop(): Promise<void> {
    // CLI-backed voices are one-process-per-wake and have no persistent handle.
  }

  async wake(event: WakeEvent): Promise<JungianVoiceTurn> {
    const startedAt = Date.now();
    const prepareStartedAt = Date.now();
    const prepared = await this.memory.prepareTurn({
      eventId: event.id,
      kind: event.kind,
      text: event.text,
      from: event.from,
      context: event.context ?? {}
    });
    const memoryPrepareMs = Date.now() - prepareStartedAt;
    const promptText = withTaskClockPrompt([
      `${this.config.name} (${this.config.id})`,
      `Self: ${this.config.selfName} (${this.config.selfId})`,
      `Role: ${this.config.archetype ?? "Representative Self"}`,
      "",
      "Standing instructions:",
      ...this.config.instructions.map((line) => `- ${line}`),
      "",
      "Daimon memory packet:",
      memorySections(prepared.promptText),
      "",
      "Current wake:",
      event.text
    ].join("\n"));

    const engineResult = await runEngineDetailed(this.config.engine, promptText, {
      runtimeHomePath: this.runtimeHomePath,
      workspacePath: this.workspacePath
    });

    const recordStartedAt = Date.now();
    await this.memory.recordTurn({
      principal: prepared.principal,
      prompt: prepared.packet,
      request: {
        eventId: event.id,
        kind: event.kind,
        text: event.text,
        from: event.from,
        context: event.context ?? {}
      },
      recall: prepared.recall,
      result: "completed",
      outputText: engineResult.text
    });
    const memoryRecordMs = Date.now() - recordStartedAt;

    return {
      engineResult,
      event,
      memoryPrepareMs,
      memoryRecordMs,
      outputText: engineResult.text,
      promptText,
      recall: prepared.recall,
      totalMs: Date.now() - startedAt,
      voice: this.config
    };
  }
}

export const runLimited = async <T, R>(
  values: readonly T[],
  limit: number,
  run: (value: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      results[current] = await run(values[current]);
    }
  });
  await Promise.all(workers);
  return results;
};
