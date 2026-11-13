import type { HarnessModelSpec } from "../core/types.js";
import type { ChildProcess } from "node:child_process";
import type { CliEngineOptions, CliSessionInput } from "../pi/cliSession.js";
import type { CliMcpRegistration } from "../pi/cliMcpRegistration.js";
import type { readChild } from "../pi/cliChildOutput.js";
import type { AgyTurnUsage } from "./agy/agyHeadlessResult.js";
import type { CodexTurnUsage } from "./codex/codexHeadlessResult.js";

/** Public CLI option discrimination, owned by engine implementations. */
export type EngineCliIdentity = { readonly engine: "codex" | "grok" } | {
  readonly engine: "agy";
  readonly dbusSessionBusAddress?: string;
};
export type EngineChildReadOptions = NonNullable<Parameters<typeof readChild>[3]>;
export type EngineMcpInput = Readonly<{
  options: CliEngineOptions;
  input: CliSessionInput;
  endpoint: string;
  secretValues: readonly string[];
  onChild: (child: ChildProcess) => void;
  onChildSettled: (child: ChildProcess) => void;
}>;
export type EngineOutputRetention = { retain: (value: Buffer) => void; finish: () => void };
export interface PiEngineHooks {
  readonly resolvePiProvider?: (model: HarnessModelSpec) => string | undefined;
  readonly createOutputRetention?: (options: EngineChildReadOptions, stdout: Buffer[], maxOutputBytes: number, abort: (error: Error) => void) => EngineOutputRetention;
  readonly environmentIntent: (options: CliEngineOptions) => { dbusSessionBusAddress?: string };
  readonly environmentVariables: (intent: { engineHomePath?: string; dbusSessionBusAddress?: string }) => NodeJS.ProcessEnv;
  readonly spawnPlan: (options: CliEngineOptions, prompt: string, input: CliSessionInput, endpoint: string | undefined) => { args: string[]; stdin?: string };
  readonly registerMcp: (input: EngineMcpInput) => Promise<CliMcpRegistration | undefined>;
  readonly brokerTurn: (options: CliEngineOptions) => CliEngineOptions["grokBrokerTurn"];
  readonly childReadOptions: (options: CliEngineOptions) => EngineChildReadOptions;
  readonly decodeOutput: (output: string) => { text: string; usage?: AgyTurnUsage | CodexTurnUsage };
  /** Per-turn usage measured from stdout as it streams, for a turn killed before its decoder ran. */
  readonly createTurnMeter?: () => { observe: (chunk: Buffer) => void; reported: () => AgyTurnUsage | CodexTurnUsage | undefined };
  readonly authenticationError: (failure: unknown, cleanupFailure?: Error) => Error | undefined;
  readonly defaultRunOptions: () => CliEngineOptions;
  readonly taskClockGap?: string;
}
