import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { renderGrokLeanBaseConfig } from "../runtime/grokBrokerWorkerConfig.js";
import type { CliMcpRegistration } from "./cliMcpRegistration.js";
import { grokTaskClockConfig } from "./engineTaskClock.js";

/**
 * Per-wake MCP registration for the direct (non-broker) Grok CLI path.
 *
 * `grok mcp add --scope project` writes `<cwd>/.grok/config.toml`, which Grok
 * 1.0.34 skips entirely in an untrusted workspace — and Daimon keeps every
 * workspace untrusted so cwd `AGENTS.md` and project skills never load. The
 * endpoint therefore goes into the agent's own Daimon-owned `GROK_HOME`
 * config, rendered from the same lean base the broker worker uses
 * (`renderGrokLeanBaseConfig`), and is removed again after the turn by
 * rewriting the base alone.
 *
 * There is no fallback to the operator's `~/.grok`: without an explicit
 * `engineHomePath` the session refuses, rather than editing a human's config.
 */
export async function registerGrokHomeMcpServer(input: Readonly<{ engineHomePath: string | undefined; endpoint: string; verify?: () => Promise<void> }>): Promise<CliMcpRegistration> {
  const home = input.engineHomePath;
  if (home === undefined || !path.isAbsolute(home)) {
    throw new Error("Grok direct CLI sessions require a Daimon-owned GROK_HOME (engineHomePath): Grok 1.0.34 ignores project-scoped MCP servers in untrusted workspaces");
  }
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9/_-]*$/u.test(input.endpoint)) throw new Error("Grok MCP endpoint must be a loopback http URL");
  await input.verify?.();
  await writeConfig(home, `${grokTaskClockConfig()}${renderGrokLeanBaseConfig()}[mcp_servers.daimon]\nurl = ${JSON.stringify(input.endpoint)}\n`);
  let closePromise: Promise<void> | undefined;
  return {
    close: (): Promise<void> => closePromise ??= (async () => {
      await input.verify?.();
      await writeConfig(home, renderGrokLeanBaseConfig());
    })()
  };
}

async function writeConfig(home: string, text: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = await lstat(home);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Grok engine home is not a private directory");
  const target = path.join(home, "config.toml");
  const temporary = path.join(home, `.config.toml.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
