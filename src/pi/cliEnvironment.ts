import path from "node:path";
import { taskClockChildEnvironment } from "../runtime/taskClock.js";

type CliEnvironmentIntent = Readonly<{
  dbusSessionBusAddress?: string;
  engine?: "codex" | "grok" | "agy";
  executablePath?: string;
  engineHomePath?: string;
  wakeId?: string;
}>;

export const DAIMON_WAKE_ID_ENV = "DAIMON_WAKE_ID" as const;

/** Build a positive child environment; agent CLIs never inherit host secrets. */
export const cliChildEnvironment = (
  _redactedNames: readonly string[], runtimeHomePath?: string, intent: CliEnvironmentIntent = {}
): NodeJS.ProcessEnv => {
  const clockEnvironment = taskClockChildEnvironment();
  if (runtimeHomePath === undefined) {
    // This legacy branch is only used by the standalone Pi helpers, which do
    // not claim production organization-runtime isolation.
    return { PATH: process.env.PATH, LANG: process.env.LANG ?? "C", LC_ALL: process.env.LC_ALL ?? "C", TZ: process.env.TZ ?? "UTC", ...clockEnvironment };
  }
  const engine = intent.engine;
  const engineVariable = engine === "codex" ? "CODEX_HOME" : engine === "grok" ? "GROK_HOME" : engine === "agy" ? "ANTIGRAVITY_CLI_HOME" : undefined;
  const engineHome = intent.engineHomePath;
  const keyringBus = engine === "agy" ? localSecretServiceBus(intent.dbusSessionBusAddress) : undefined;
  return {
    // The executable is pinned absolutely. PATH remains only for a trusted
    // interpreter in a local shebang (and never selects the engine itself).
    PATH: intent.executablePath === undefined ? process.env.PATH : `${path.dirname(intent.executablePath)}${path.delimiter}${path.dirname(process.execPath)}`,
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    TZ: process.env.TZ ?? "UTC",
    HOME: runtimeHomePath,
    XDG_CONFIG_HOME: `${runtimeHomePath}/.config`,
    XDG_DATA_HOME: `${runtimeHomePath}/.local/share`,
    XDG_STATE_HOME: `${runtimeHomePath}/.local/state`,
    XDG_CACHE_HOME: `${runtimeHomePath}/.cache`,
    TMPDIR: `${runtimeHomePath}/.tmp`,
    ...clockEnvironment,
    ...(engineVariable === undefined || engineHome === undefined ? {} : { [engineVariable]: engineHome }),
    ...(keyringBus === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: keyringBus }),
    ...(intent.wakeId === undefined ? {} : { [DAIMON_WAKE_ID_ENV]: intent.wakeId })
  };
};

const localSecretServiceBus = (value: string | undefined): string | undefined =>
  value !== undefined && /^unix:(?:path|abstract)=[^;,\r\n]+$/u.test(value) ? value : undefined;
