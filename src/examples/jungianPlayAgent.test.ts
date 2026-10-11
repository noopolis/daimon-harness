import assert from "node:assert/strict";
import test from "node:test";
import * as mneme from "@noopolis/mneme";
import { JungianVoice } from "./jungianPlayAgent.js";

test("the direct memory example uses the same startup validation and Mneme capability gate", (t) => {
  const previous = process.env; process.env = { ...previous, NOOPOLIS_TASK_CLOCK: "invalid" };
  t.after(() => { process.env = previous; });
  const config = { engine: "codex" as const, id: "voice", instructions: [], name: "Voice", runtimeRoot: "/must-not-be-created", selfId: "self", selfName: "Self" };
  assert.throws(() => new JungianVoice(config), /NOOPOLIS_TASK_CLOCK/u);
  if (!("createOffsetClock" in mneme)) {
    process.env.NOOPOLIS_TASK_CLOCK = '{"version":"noopolis.task-clock.v1","origin":"2024-01-01T00:00:00Z","anchorEpochMs":0}';
    assert.throws(() => new JungianVoice(config), /@noopolis\/mneme.*createOffsetClock/u);
  }
});
