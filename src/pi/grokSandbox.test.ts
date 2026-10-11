import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GROK_DAIMON_SANDBOX_PROFILE,
  prepareAndVerifyGrokSandbox
} from "./grokSandbox.js";

test("requires an enforced custom profile containing every protected peer and credential root", async (t) => {
  const previousEnvironment = process.env;
  process.env = { ...previousEnvironment, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }), LD_PRELOAD: "/missing/libfaketime.so.1", FAKETIME: "stale" };
  t.after(() => { process.env = previousEnvironment; });
  const fixture = await createFixture();
  try {
    await prepareAndVerifyGrokSandbox(fixture.authority);
    const profile = await readFile(path.join(fixture.engineHomePath, "sandbox.toml"), "utf8");
    assert.match(profile, new RegExp(`profiles\\.${GROK_DAIMON_SANDBOX_PROFILE}`, "u"));
    for (const protectedPath of fixture.protectedPaths) assert.match(profile, new RegExp(escape(protectedPath), "u"));
    assert.doesNotMatch(profile, /credential-canary/u);
  } finally { await rm(fixture.root, { force: true, recursive: true }); }
});

test("fails closed when Grok reports a fail-open sandbox or drops one deny path", async () => {
  for (const mode of ["unenforced", "drop-deny"] as const) {
    const fixture = await createFixture(mode);
    try {
      await assert.rejects(
        prepareAndVerifyGrokSandbox(fixture.authority),
        /kernel sandbox enforcement is unavailable/u
      );
    } finally { await rm(fixture.root, { force: true, recursive: true }); }
  }
});

test("rejects a protected root overlapping the selected agent workspace", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(prepareAndVerifyGrokSandbox({
      ...fixture.authority,
      protectedPaths: [...fixture.protectedPaths, fixture.cwd]
    }), /kernel sandbox enforcement is unavailable/u);
  } finally { await rm(fixture.root, { force: true, recursive: true }); }
});

test("rotates its private enforcement receipt before the bounded log is exhausted", async () => {
  const fixture = await createFixture();
  try {
    const events = path.join(fixture.engineHomePath, "sessions", "sandbox-events.jsonl");
    await mkdir(path.dirname(events), { mode: 0o700 });
    await writeFile(events, "x".repeat(8 * 1024 * 1024), { mode: 0o600 });
    await prepareAndVerifyGrokSandbox(fixture.authority);
    assert.ok((await readFile(events)).byteLength < 64 * 1024);
  } finally { await rm(fixture.root, { force: true, recursive: true }); }
});

async function createFixture(mode: "valid" | "unenforced" | "drop-deny" = "valid"): Promise<{
  authority: Parameters<typeof prepareAndVerifyGrokSandbox>[0];
  cwd: string;
  engineHomePath: string;
  protectedPaths: string[];
  root: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-grok-sandbox-"));
  const runtimeHomePath = path.join(root, "runtime-home");
  const engineHomePath = path.join(runtimeHomePath, ".grok");
  const cwd = path.join(root, "workspace");
  const protectedPaths = [path.join(root, "credential-realm"), path.join(root, "peer-home")];
  await Promise.all([runtimeHomePath, engineHomePath, cwd, ...protectedPaths].map((directory) =>
    mkdir(directory, { mode: 0o700, recursive: true })
  ));
  await writeFile(path.join(protectedPaths[0]!, "auth.json"), "credential-canary", { mode: 0o600 });
  const command = path.join(root, "grok");
  await writeFile(command, `#!/usr/bin/env node
const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),home=process.env.GROK_HOME;
const profile=fs.readFileSync(path.join(home,"sandbox.toml"),"utf8");
const deny=JSON.parse(profile.split("\\n").find((line)=>line.startsWith("deny = ")).slice(7));
const observed=${JSON.stringify(mode)}==="drop-deny"?deny.slice(1):deny;
const event={event_type:"ProfileApplied",profile:"${GROK_DAIMON_SANDBOX_PROFILE}",workspace:fs.realpathSync(args[args.indexOf("--cwd")+1]),platform:"linux/landlock",enforced:${JSON.stringify(mode)}!=="unenforced",restrict_network:true,deny_paths:observed};
fs.appendFileSync(path.join(home,"sessions","sandbox-events.jsonl"),JSON.stringify(event)+"\\n",{mode:0o600});
fs.chmodSync(path.join(home,"sessions","sandbox-events.jsonl"),0o600);
`);
  await chmod(command, 0o700);
  return {
    authority: { command, cwd, engineHomePath, protectedPaths, runtimeHomePath },
    cwd,
    engineHomePath,
    protectedPaths,
    root
  };
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
