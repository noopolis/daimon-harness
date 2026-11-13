import type { CliEngineOptions } from "../../pi/cliSession.js";

/**
 * AGY's headless invocation.
 *
 * `--output-format stream-json` is unconditional: it is the only shape that
 * carries `result.usage`, and an AGY turn that is not metered is an AGY turn
 * whose subscription cost is invisible (see `agyHeadlessResult.ts`).
 *
 * `--dangerously-skip-permissions` is required for tools to work at all. AGY's
 * default headless permission mode is `request-review`, and there is no
 * reviewer inside a container, so a tool call can never be approved without it;
 * the live probe that proved AGY's MCP tool calling ran with exactly this flag
 * and reported `permission_mode: always-proceed`. Every Daimon CLI agent mounts
 * at least the protected bash tool (`piHarness.ts`), so there is no AGY wake
 * for which this is unnecessary and no conditional worth forking behavior over.
 *
 * SECURITY: the flag also auto-approves AGY's own ~50 built-in tools —
 * `run_command`, `write_to_file`, the browser tools — none of which Daimon
 * mediates. Inside the container that is the exposure Codex already has
 * (`--sandbox danger-full-access`), but unlike Grok there is no kernel-enforced
 * per-agent profile confining it to this agent's own workspace and runtime
 * home. `DAIMON_AGY_SANDBOX=1` opts into AGY's own terminal-restricting
 * sandbox; it is off by default only because its interaction with the MCP
 * transport could not be verified without spending the operator's subscription
 * quota, and shipping an unverified default that silently disables every tool
 * would be worse than shipping the exposure with this note on it.
 */
export const renderAgyArgs = (
  options: Pick<CliEngineOptions, "commandArgs" | "timeoutMs">,
  prompt: string,
  sandbox: boolean = process.env.DAIMON_AGY_SANDBOX === "1",
  readableDirectories: readonly string[] = []
): string[] => [
  ...assertSafeAgyCommandArgs(options.commandArgs),
  "--print", prompt,
  "--output-format", "stream-json",
  "--dangerously-skip-permissions",
  ...(sandbox ? ["--sandbox"] : []),
  ...(options.timeoutMs === undefined ? [] : ["--print-timeout", `${options.timeoutMs}ms`]),
  ...readableDirectories.flatMap((directory) => ["--add-dir", directory])
];

/**
 * Where AGY materializes each registered MCP server's tool schemas, under its
 * own `HOME`. AGY reads a schema with `view_file` before every `call_mcp_tool`,
 * and its permission check refuses any read outside the workspace, so with the
 * runtime home outside the workspace (as in every Daimon organization) an AGY
 * agent could see its Daimon tools listed but never call one: a Tinkerton trial
 * spent 75 steps searching the filesystem and filed nothing. Only this
 * directory is added, never the whole home, which holds AGY's conversations.
 */
export const agyMcpSchemaDirectory = (homePath: string): string => `${homePath}/.gemini/antigravity-cli/mcp`;

/**
 * AGY's output format, permission mode, sandbox, and session continuity are
 * Daimon-owned, exactly as Grok's sandbox and approval flags are. A caller
 * cannot re-open the permission boundary, silence the metering stream, or turn
 * a per-wake cold process into a resumed conversation through `commandArgs`.
 */
const assertSafeAgyCommandArgs = (args: readonly string[] | undefined): readonly string[] => {
  const values = args ?? [];
  if (values.some((value) => /^(?:--dangerously-skip-permissions|--sandbox|--output-format|--print|--prompt|--prompt-interactive|--mode|--continue|--conversation|-p|-i|-c)(?:=|$)/u.test(value))) {
    throw new Error("AGY security-boundary arguments are Daimon-owned");
  }
  return values;
};
