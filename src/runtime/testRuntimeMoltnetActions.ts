import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { isCanonicalScheduleDeliveryId } from "./schedule.js";
import { readyTaskClockEnvironment } from "./taskClockProcess.js";

const run = promisify(execFile);
const MAX_ACTIONS = 16;
const MAX_TEXT_BYTES = 16_384;

export type ScriptedMoltnetAction = Readonly<{ delivery_id: string; network_id: string; target: string; text: string }>;
export type ScriptedMoltnetReceipt = Readonly<{ delivery_id: string; message_id: string; network_id: string; target: string }>;

export async function createScriptedMoltnetActions(value: unknown, cliPath: unknown, configPath: unknown): Promise<(deliveryId: string) => Promise<ScriptedMoltnetReceipt[]>> {
  const actions = parseActions(value);
  if (actions.length === 0) return async () => [];
  if (!absolute(cliPath) || !absolute(configPath)) throw new Error("scripted Moltnet actions require absolute CLI and client config paths");
  const config = parseConfig(JSON.parse(await readFile(configPath, "utf8")));
  for (const action of actions) assertDeclared(config, action);
  return async (deliveryId) => {
    const receipts: ScriptedMoltnetReceipt[] = [];
    for (const action of actions.filter((candidate) => candidate.delivery_id === deliveryId)) {
      const { stdout } = await run(cliPath, ["send", "--config", configPath, "--network", action.network_id, "--target", action.target, "--text", action.text], {
        env: readyTaskClockEnvironment({ ...process.env, DAIMON_WAKE_ID: deliveryId }), maxBuffer: 65_536, timeout: 10_000
      });
      const receipt = record(JSON.parse(stdout));
      if (receipt.accepted !== true || typeof receipt.message_id !== "string" || !receipt.message_id) throw new Error("Moltnet action was not accepted");
      receipts.push({ delivery_id: deliveryId, message_id: receipt.message_id, network_id: action.network_id, target: action.target });
    }
    return receipts;
  };
}

function parseActions(value: unknown): ScriptedMoltnetAction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ACTIONS) throw new Error("invalid scripted Moltnet actions");
  return value.filter((item) => record(item).type !== "mcp_call").map((item) => {
    const row = record(item); exact(row, ["delivery_id", "network_id", "target", "text"]);
    if (![row.delivery_id, row.network_id, row.target, row.text].every(nonblank) || !deliveryId(row.delivery_id as string) || Buffer.byteLength(row.text as string) > MAX_TEXT_BYTES || !/^(?:room|dm):[^\s:]+$/u.test(row.target as string)) throw new Error("invalid scripted Moltnet action");
    return row as unknown as ScriptedMoltnetAction;
  });
}
function parseConfig(value: unknown): { attachments: Array<Record<string, unknown>> } {
  const root = record(value);
  if (root.version !== "moltnet.client.v1" || !Array.isArray(root.attachments)) throw new Error("invalid compiled Moltnet client config");
  return { attachments: root.attachments.map(record) };
}
function assertDeclared(config: { attachments: Array<Record<string, unknown>> }, action: ScriptedMoltnetAction): void {
  const attachment = config.attachments.find((item) => item.network_id === action.network_id);
  if (!attachment) throw new Error("scripted Moltnet network is not declared");
  const [kind, id] = action.target.split(":", 2) as ["room" | "dm", string];
  if (kind === "room") {
    const rooms = Array.isArray(attachment.rooms) ? attachment.rooms.map(record) : [];
    if (!rooms.some((room) => room.id === id)) throw new Error("scripted Moltnet room is not declared");
  } else {
    const dms = record(attachment.dms);
    if (dms.enabled !== true) throw new Error("scripted Moltnet DMs are not declared");
  }
}
function record(value: unknown): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new Error("unexpected scripted Moltnet action field"); }
function nonblank(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function absolute(value: unknown): value is string { return nonblank(value) && value.startsWith("/"); }
function deliveryId(value: string): boolean {
  return value.length <= 256 && (/^moltnet:[A-Za-z0-9._~-]+$/u.test(value) || isCanonicalScheduleDeliveryId(value));
}
