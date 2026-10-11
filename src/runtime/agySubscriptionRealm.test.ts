import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createAgyRealmCommands,
  readAgyRealmUnlockSecret,
  startAgySubscriptionRealm
} from "./agySubscriptionRealm.js";

const execFile = promisify(execFileCallback);

test("constructs a private Secret Service realm without unlock bytes in commands", () => {
  const commands = createAgyRealmCommands({
    busSocketPath: "/ephemeral/bus",
    controlDirectory: "/ephemeral/keyring"
  });
  assert.deepEqual(commands.bus.args, ["--session", "--nofork", "--nopidfile", "--address=unix:path=/ephemeral/bus"]);
  assert.deepEqual(commands.keyring.args, ["--foreground", "--components=secrets", "--unlock", "--control-directory=/ephemeral/keyring"]);
  assert.equal(commands.lease.command, "/bin/sh");
  assert.deepEqual(commands.lease.args, [
    "-c",
    "\"$1\" --exclusive --nonblock --conflict-exit-code 73 3 || exit 73; printf 'ready\\n'; IFS= read -r _daimon_hold || :",
    "daimon-agy-lease",
    "flock"
  ]);
  assert.equal(JSON.stringify(commands).includes("unlock-canary"), false);
});

test("accepts only one caller-owned 0600 bounded unlock file and redacts failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-agy-unlock-"));
  const secretPath = path.join(root, "operator-secret-canary");
  const aliasPath = path.join(root, "alias");
  try {
    await writeFile(secretPath, "unlock-canary", { mode: 0o600 });
    await chmod(secretPath, 0o600);
    const bytes = await readAgyRealmUnlockSecret(secretPath);
    assert.equal(bytes.toString("utf8"), "unlock-canary");
    bytes.fill(0);
    await symlink(secretPath, aliasPath);
    await assert.rejects(readAgyRealmUnlockSecret(aliasPath), (error: Error) => {
      assert.equal(error.message, "AGY subscription realm unlock secret is unavailable or unsafe");
      assert.doesNotMatch(error.message, /operator-secret-canary|unlock-canary/);
      return true;
    });
    await chmod(secretPath, 0o640);
    await assert.rejects(readAgyRealmUnlockSecret(secretPath), /unavailable or unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("starts, unlocks through stdin, cleans ephemeral state, and preserves durable state", async (t) => {
  const previousEnvironment = process.env;
  process.env = { ...previousEnvironment, NOOPOLIS_TASK_CLOCK: JSON.stringify({ version: "noopolis.task-clock.v1", origin: "2001-01-01T00:00:00Z", anchorEpochMs: Date.now() }), LD_PRELOAD: "/missing/libfaketime.so.1", FAKETIME: "stale" };
  t.after(() => { process.env = previousEnvironment; });
  const fixture = await createRealmFixture();
  try {
    const realm = await startAgySubscriptionRealm(fixture.options);
    assert.match(realm.busAddress, /^unix:path=/u);
    const socketPath = realm.busAddress.slice("unix:path=".length);
    await access(socketPath);
    await realm.close();
    await realm.close();
    await assert.rejects(access(socketPath));
    assert.equal(await readFile(path.join(fixture.durablePath, "sentinel"), "utf8"), "durable");
    assert.equal(await readFile(fixture.unlockObservation, "utf8"), "stdin-only:13");
  } finally {
    await fixture.close();
  }
});

test("rejects a concurrent durable-volume holder", async (context) => {
  if (process.platform !== "linux") {
    context.skip("util-linux flock integration is Linux-only");
    return;
  }
  const fixture = await createRealmFixture({ realFlock: true });
  let first: Awaited<ReturnType<typeof startAgySubscriptionRealm>> | undefined;
  try {
    first = await startAgySubscriptionRealm(fixture.options);
    await assert.rejects(startAgySubscriptionRealm(fixture.options), /already in use or cannot be leased/);
  } finally {
    await first?.close();
    await fixture.close();
  }
});

test("real Linux Secret Service realm unlocks the same encrypted keyring after restart", async (context) => {
  if (process.platform !== "linux" || !await commandsAvailable(["dbus-daemon", "dbus-send", "flock", "gnome-keyring-daemon"])) {
    context.skip("real D-Bus, Secret Service, and flock integration is unavailable");
    return;
  }
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "daimon-agy-real-realm-")));
  const durablePath = path.join(root, "durable");
  const temporaryRoot = path.join(root, "temporary");
  const unlockSecretPath = path.join(root, "unlock");
  await Promise.all([mkdir(durablePath, { mode: 0o700 }), mkdir(temporaryRoot, { mode: 0o700 })]);
  await writeFile(unlockSecretPath, "integration-canary", { mode: 0o600 });
  await chmod(unlockSecretPath, 0o600);
  const options = { durablePath, temporaryRoot, unlockSecretPath };
  try {
    const first = await startAgySubscriptionRealm(options);
    assert.equal(await loginCollectionLocked(first.busAddress), false);
    await first.close();
    await first.close();
    const second = await startAgySubscriptionRealm(options);
    assert.equal(await loginCollectionLocked(second.busAddress), false);
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function commandsAvailable(commands: string[]): Promise<boolean> {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const command of commands) {
    let found = false;
    for (const directory of directories) {
      try { await access(path.join(directory, command), constants.X_OK); found = true; break; } catch { /* keep looking */ }
    }
    if (!found) return false;
  }
  return true;
}

async function loginCollectionLocked(busAddress: string): Promise<boolean> {
  const { stdout } = await execFile("dbus-send", [
    `--bus=${busAddress}`,
    "--dest=org.freedesktop.secrets",
    "--print-reply",
    "/org/freedesktop/secrets/collection/login",
    "org.freedesktop.DBus.Properties.Get",
    "string:org.freedesktop.Secret.Collection",
    "string:Locked"
  ], { timeout: 2_000 });
  if (/boolean false/u.test(stdout)) return false;
  if (/boolean true/u.test(stdout)) return true;
  throw new Error("Secret Service did not report the login collection lock state");
}

async function createRealmFixture(input: { realFlock?: boolean } = {}): Promise<{
  close(): Promise<void>;
  durablePath: string;
  options: Parameters<typeof startAgySubscriptionRealm>[0];
  unlockObservation: string;
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "daimon-agy-realm-fixture-")));
  const durablePath = path.join(root, "durable");
  const temporaryRoot = path.join(root, "temporary");
  const unlockSecretPath = path.join(root, "unlock");
  const unlockObservation = path.join(root, "unlock-observation");
  const bus = path.join(root, "fake-dbus.mjs");
  const keyring = path.join(root, "fake-keyring.mjs");
  const lease = path.join(root, "fake-flock.mjs");
  await Promise.all([
    mkdir(durablePath, { mode: 0o700 }),
    mkdir(temporaryRoot, { mode: 0o700 })
  ]);
  await writeFile(path.join(durablePath, "sentinel"), "durable");
  await writeFile(unlockSecretPath, "unlock-canary", { mode: 0o600 });
  await chmod(unlockSecretPath, 0o600);
  await writeFile(bus, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const address = process.argv.find((value) => value.startsWith('--address=unix:path='));",
    "const socket = address.slice('--address=unix:path='.length); writeFileSync(socket, 'socket');",
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1000);"
  ].join("\n"), { mode: 0o700 });
  await writeFile(keyring, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const control = process.argv.find((value) => value.startsWith('--control-directory=')).slice('--control-directory='.length);",
    "const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);",
    `writeFileSync(${JSON.stringify(unlockObservation)}, 'stdin-only:' + Buffer.concat(chunks).length);`,
    "writeFileSync(control + '/control', 'socket');",
    "process.on('SIGTERM', () => process.exit(0)); setInterval(() => undefined, 1000);"
  ].join("\n"), { mode: 0o700 });
  await writeFile(lease, [
    "#!/usr/bin/env node",
    "process.exit(0);"
  ].join("\n"), { mode: 0o700 });
  await Promise.all([chmod(bus, 0o700), chmod(keyring, 0o700), chmod(lease, 0o700)]);
  return {
    close: async () => rm(root, { recursive: true, force: true }),
    durablePath,
    options: {
      dbusDaemon: bus,
      durablePath,
      ...(input.realFlock ? {} : { flock: lease }),
      gnomeKeyringDaemon: keyring,
      socketReady: async (socketPath) => { await access(socketPath); return true; },
      temporaryRoot: `${temporaryRoot}${path.sep}`,
      unlockSecretPath
    },
    unlockObservation
  };
}
