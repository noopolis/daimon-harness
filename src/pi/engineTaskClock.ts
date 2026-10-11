import { readTaskClock, taskClockChildEnvironment } from "../runtime/taskClock.js";

/** Explicit set is scoped by the engines to shell/tool children, never provider traffic.
 * Pin an empty allowlist so ambient include filters cannot discard the clock values.
 * Sources/versions and the broker/AGY gaps are recorded in docs/runtime.md.
 */
export function codexTaskClockArgs(): string[] {
  const env = taskClockChildEnvironment();
  if (Object.keys(env).length === 0) return [];
  return ["-c", `shell_environment_policy=${shellPolicy(env)}`];
}

export function grokTaskClockConfig(): string {
  const env = taskClockChildEnvironment();
  return Object.keys(env).length === 0 ? "" : `shell_environment_policy = ${shellPolicy(env)}\n`;
}

function shellPolicy(env: Record<string, string>): string {
  const set = Object.entries(env).map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`).join(",");
  return `{inherit="all",ignore_default_excludes=false,exclude=[],include_only=[],set={${set}}}`;
}

/** Operational readiness diagnostic only: unsupported native tools do not refuse a wake. */
export function reportEngineTaskClockGap(engine: "codex" | "grok" | "agy", brokered = false): void {
  if (readTaskClock() === undefined) return;
  const gap = engine === "agy" ? "no supported tool-only environment setting"
    : engine === "grok" && brokered ? "attested broker worker config has no per-wake shell environment input" : undefined;
  if (gap) console.warn(`daimon: task clock coverage gap engine=${engine}: ${gap}; native tools remain on real time; wake allowed`);
}
