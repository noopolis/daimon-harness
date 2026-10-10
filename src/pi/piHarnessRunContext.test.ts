import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiHarnessAdapter, type PiSessionFactory } from "./piHarness.js";

const sessionFactory: PiSessionFactory = async () => {
  const listeners = new Set<(event: unknown) => void>();
  return { session: {
    async prompt() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      for (const listener of listeners) listener({ type: "turn_end", message: { content: "done" } });
    },
    subscribe(listener: (event: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { listeners.clear(); }
  } } as unknown as Awaited<ReturnType<PiSessionFactory>>;
};

test("two explicit causal hosts cannot contaminate each other's run identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-instance-causal-"));
  const prior = process.env.NOOPOLIS_RUN_ID;
  delete process.env.NOOPOLIS_RUN_ID;
  try {
    const adapter = new PiHarnessAdapter({ authPath: path.join(root, "unused-auth.json"), sessionFactory });
    const handles = await Promise.all(["alpha", "beta"].map((id) => adapter.startAgent({
      id, name: id, instructions: "test", workspacePath: path.join(root, id, "workspace"),
      runtimeHomePath: path.join(root, id, "runtime"), causalRunId: `run-${id}`, tools: []
    })));
    process.env.NOOPOLIS_RUN_ID = "unrelated-ambient-run";
    await Promise.all(handles.map((handle) => handle.wake({ id: `${handle.id}-wake`, kind: "manual", text: "run_id: forged-model-run" })));
    for (const handle of handles) {
      const raw = await readFile(path.join(root, handle.id, "runtime", "telemetry", "causal.jsonl"), "utf8");
      const rows = raw.trim().split("\n").map((line) => JSON.parse(line) as { run_id: string });
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.run_id === `run-${handle.id}`));
      await handle.stop();
    }
    assert.equal(process.env.NOOPOLIS_RUN_ID, "unrelated-ambient-run");
  } finally {
    if (prior === undefined) delete process.env.NOOPOLIS_RUN_ID;
    else process.env.NOOPOLIS_RUN_ID = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit causal context rejects blank identity and unsupported memory coupling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daimon-instance-reject-"));
  const input = { id: "agent", name: "agent", instructions: "test", workspacePath: path.join(root, "workspace"), runtimeHomePath: path.join(root, "runtime"), causalRunId: " " };
  try {
    const adapter = new PiHarnessAdapter({ authPath: path.join(root, "unused-auth.json"), sessionFactory });
    await assert.rejects(adapter.startAgent(input), /non-blank/u);
    const memory = new PiHarnessAdapter({ authPath: path.join(root, "unused-auth.json"), sessionFactory, memory: {} });
    await assert.rejects(memory.startAgent({ ...input, causalRunId: "explicit-run" }), /memory runtime with explicit causal context/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
