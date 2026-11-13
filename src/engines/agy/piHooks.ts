import { ENGINE_DESCRIPTORS } from "../descriptors.js";
import type { PiEngineHooks } from "../piHooks.js";
import { cliChildEnvironment } from "../../pi/cliEnvironment.js";
import { registerCliMcpServer } from "../../pi/cliMcpRegistration.js";
import { renderAgyMcpAddArgs, renderAgyMcpRemoveArgs } from "./piMcpRegistration.js";
import { agyMcpSchemaDirectory, renderAgyArgs } from "./piArgs.js";
import { decodeAgyHeadlessTurn } from "./agyHeadlessResult.js";
import { createAgyTurnMeter } from "./agyTurnMeter.js";
import { createAgyOutputRetention } from "./agyOutputRetention.js";

export const AGY_MAX_TOOL_TURNS = 16;
const localSecretServiceBus = (value: string | undefined): string | undefined =>
  value !== undefined && /^unix:(?:path|abstract)=[^;,\r\n]+$/u.test(value) ? value : undefined;

export const agyPiHooks: PiEngineHooks = {
  environmentIntent: (options) => ({ dbusSessionBusAddress: options.engine === "agy" ? options.dbusSessionBusAddress : undefined }),
  environmentVariables: ({ engineHomePath, dbusSessionBusAddress }) => {
    const bus = localSecretServiceBus(dbusSessionBusAddress);
    return { ...(engineHomePath === undefined ? {} : { [ENGINE_DESCRIPTORS.agy.homeEnvironment]: engineHomePath }), ...(bus === undefined ? {} : { [ENGINE_DESCRIPTORS.agy.auth.busEnvironment]: bus }) };
  },
  spawnPlan: (options, prompt, input, endpoint) => ({
    args: renderAgyArgs(options, prompt, undefined, endpoint === undefined || input.runtimeHomePath === undefined ? [] : [agyMcpSchemaDirectory(input.runtimeHomePath)])
  }),
  registerMcp: async ({ options, input, endpoint, onChild, onChildSettled, secretValues }) => {
    await options.verifyExecutable?.();
    return registerCliMcpServer({
      addArgs: renderAgyMcpAddArgs(options.commandArgs, endpoint),
      removeArgs: renderAgyMcpRemoveArgs(options.commandArgs), command: options.command ?? options.engine,
      cwd: input.cwd,
      env: cliChildEnvironment([...(options.redactedEnvironmentNames ?? []), ...(input.daimonSecretEnvironmentNames ?? [])], input.runtimeHomePath, {
        ...(options.engine === "agy" && options.dbusSessionBusAddress !== undefined ? { dbusSessionBusAddress: options.dbusSessionBusAddress } : {}),
        engine: options.engine, executablePath: options.command, engineHomePath: options.engineHomePath
      }), onChild, onChildSettled, secretValues
    });
  },
  brokerTurn: () => undefined,
  childReadOptions: () => ({ retainNdjson: "agy" }),
  createOutputRetention: createAgyOutputRetention,
  decodeOutput: decodeAgyHeadlessTurn,
  createTurnMeter: createAgyTurnMeter,
  authenticationError: () => undefined,
  defaultRunOptions: () => ({ engine: "agy", maxToolTurns: AGY_MAX_TOOL_TURNS, timeoutMs: 180_000 }),
  taskClockGap: "no supported tool-only environment setting"
};
