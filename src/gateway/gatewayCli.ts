import { readFile, stat } from "node:fs/promises";
import { GROK_ENGINE_BROKER } from "../contracts/runtimeContractManifest.js";
import { startCodexSubscriptionRealm } from "../engines/codex/codexSubscriptionRealm.js";
import { startGrokSubscriptionRealm } from "../engines/grok/broker/grokSubscriptionRealm.js";
type HeldRealm = Readonly<{ close(): Promise<void> }>;
import { createCodexRealmOwner, type CodexRealmOwner } from "./codexRealmOwner.js";
import { createCodexRefresh } from "./codexRefresh.js";
import { parseGatewayConfig } from "./config.js";
import { createGrokRealmOwner, type GrokRealmOwner } from "./grokRealmOwner.js";
import { createGrokRefresh, sweepGrokRefreshScratch } from "./grokRefresh.js";
import { readGatewayKeyTable } from "./keyTable.js";
import type { RealmOwner } from "./realmOwner.js";
import { startGatewayServer, type GatewayServer } from "./server.js";

const MAX_CONFIG_BYTES = 65_536;

export type RunningGateway = Readonly<{ server: GatewayServer; stop(): Promise<void> }>;

const realmPaths = (config: Readonly<{ realmPath?: string; bootstrapPath?: string }>) => ({
  ...(config.realmPath === undefined ? {} : { durablePath: config.realmPath }),
  ...(config.bootstrapPath === undefined ? {} : { bootstrapPath: config.bootstrapPath })
});
const upstream = (config: Readonly<{ upstreamBaseUrl?: string }>) => config.upstreamBaseUrl === undefined ? {} : { upstreamBaseUrl: config.upstreamBaseUrl };

/** `daimon-runtime gateway --config <path>`: the sole holder of each configured realm login. */
export async function runGatewayCli(arguments_: readonly string[]): Promise<RunningGateway> {
  if (arguments_.length !== 2 || arguments_[0] !== "--config" || !arguments_[1]) throw new Error("usage: daimon-runtime gateway --config <path>");
  if ((await stat(arguments_[1])).size > MAX_CONFIG_BYTES) throw new Error("gateway config is too large");
  const config = parseGatewayConfig(JSON.parse(await readFile(arguments_[1], "utf8")));
  const keys = await readGatewayKeyTable(config.keyTablePath);
  const realms: HeldRealm[] = [];
  const owners: RealmOwner<object>[] = [];
  let server: GatewayServer;
  // Test-only: each realm refreshes once on its first request, to prove a mid-run rotation end to end.
  const forceRefreshOnce = process.env.DAIMON_GATEWAY_TEST_FORCE_REFRESH === "1";
  try {
    // Each realm's exclusive flock is held for the gateway's whole life: a second gateway on a login fails here.
    let codex: Readonly<{ owner: CodexRealmOwner; upstreamBaseUrl?: string }> | undefined;
    let grok: Readonly<{ owner: GrokRealmOwner; upstreamBaseUrl?: string }> | undefined;
    if (config.codex !== undefined) {
      const realm = await startCodexSubscriptionRealm(realmPaths(config.codex));
      realms.push(realm);
      const owner = await createCodexRealmOwner({ authority: realm.authority, forceRefreshOnce, refresh: createCodexRefresh(config.codex.tokenUrl === undefined ? {} : { tokenUrl: config.codex.tokenUrl }) });
      owners.push(owner);
      codex = { owner, ...upstream(config.codex) };
    }
    if (config.grok !== undefined) {
      const realm = await startGrokSubscriptionRealm(realmPaths(config.grok));
      realms.push(realm);
      await sweepGrokRefreshScratch(config.grok.scratchPath);
      const refresh = createGrokRefresh({ command: config.grok.command ?? GROK_ENGINE_BROKER.grokExecutablePath, ...(config.grok.scratchPath === undefined ? {} : { scratchRoot: config.grok.scratchPath }) });
      const owner = await createGrokRealmOwner({ authority: realm.authority, forceRefreshOnce, refresh });
      owners.push(owner);
      grok = { owner, ...upstream(config.grok) };
    }
    server = await startGatewayServer({ host: config.host, port: config.port, keys, ...(codex === undefined ? {} : { codex }), ...(grok === undefined ? {} : { grok }) });
  } catch (error) {
    for (const owner of owners) owner.close();
    await Promise.allSettled(realms.map((realm) => realm.close()));
    throw error;
  }
  process.stderr.write(`daimon gateway: listening on ${server.url} (${keys.size} agent keys)\n`);
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => stopping ??= (async () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    for (const owner of owners) owner.close();
    try { await server.close(); } finally {
      const closed = await Promise.allSettled(realms.map((realm) => realm.close()));
      const failed = closed.find((entry) => entry.status === "rejected");
      if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    }
  })();
  const onSignal = (): void => { void stop().catch(() => { process.exitCode = 1; }); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { server, stop };
}
