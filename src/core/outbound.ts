import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { loadChannel, openChannel, type ChannelId, type OutboundMessage } from "./channels.js";
import { InputError } from "./inputs.js";
import { createRecord, listRecords } from "./numbered.js";
import { PAUSED_REASON, isPaused } from "./pause.js";
import { loadPinnedSolution } from "./pin.js";
import { buildReport } from "./report.js";
import { SANDBOX_MODE_REASON, sandboxMode } from "./sandbox.js";
import { loadState } from "./state.js";

/**
 * R6, D79: no real outbound message during the install. Every message the engine sends goes through `deliver`,
 * which sends it only when the install is finished (the report says ready, or ready with limits) and the channel
 * was verified by `taskfollow channel`; otherwise it is recorded in `sandbox/outbox/` (the recording sink, §4.2)
 * and audited. No exception, not even for a join confirmation. Sandbox mode (D91) records them too, and a sandbox
 * run records every other action it would take as well (`recordAction`), so nothing it does is real. While the
 * engine is paused (the kill switch, D101) every message is recorded as well.
 */
export const OUTBOX_DIR = join("sandbox", "outbox");

export type Delivery = { readonly status: "sent" } | { readonly status: "recorded"; readonly outbox_id: number; readonly reason: string };

type Recorded = OutboundMessage & {
  readonly id: number;
  readonly channel: ChannelId;
  readonly at: string;
  readonly reason: string;
  readonly run?: string;
};

/** An action a sandbox run would have taken (D91): the exact call and the level the gate derived, never run. */
type RecordedAction = {
  readonly id: number;
  readonly action: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };
  readonly level: string;
  readonly at: string;
  readonly reason: string;
  readonly run?: string;
};

type Env = Readonly<Record<string, string | undefined>>;

/** Why a real send is not allowed yet, or null when it is. */
export async function outboundBlock(home: string): Promise<string | null> {
  if (await isPaused(home)) return PAUSED_REASON;
  if (await sandboxMode(home)) return SANDBOX_MODE_REASON;
  const state = await loadState(home);
  if (!state) return "there is no install in this home";
  const overall = buildReport((await loadPinnedSolution(home)).solution, state).overall;
  return overall === "ready" || overall === "ready_with_limits" ? null : "the install is not finished, so messages are recorded, not sent (R6)";
}

export const SANDBOX_REASON = "a sandbox run: messages are recorded, never sent (D90)";
export const SANDBOX_ACTION_REASON = "a sandbox run: actions are recorded, never run, and need no approval (D91)";

/** `run` names the workflow run (`<workflow>/<run_id>`) a recording belongs to, so a dry run can show its own. */
export async function deliver(home: string, channel: ChannelId, message: OutboundMessage, now: string, env: Env = process.env, sandbox = false, run?: string): Promise<Delivery> {
  if (!(await loadChannel(home, channel))) throw new InputError(`The ${channel} channel is not set up: run 'taskfollow channel ${channel}' first`);
  const reason = sandbox ? SANDBOX_REASON : await outboundBlock(home);
  if (reason !== null) {
    const recorded = await createRecord<Recorded>(home, OUTBOX_DIR, (id) => ({ id, channel, ...message, at: now, reason, ...(run ? { run } : {}) }));
    await appendAudit(home, { ts: now, actor: "engine", event: "channel.recorded", ref: channel, payload: { outbox_id: recorded.id, reason } });
    return { status: "recorded", outbox_id: recorded.id, reason };
  }
  await (await openChannel(home, channel, env)).send(message);
  await appendAudit(home, { ts: now, actor: "engine", event: "channel.sent", ref: channel, payload: { to: message.to } });
  return { status: "sent" };
}
export async function recordAction(home: string, action: RecordedAction["action"], level: string, now: string, run?: string): Promise<Readonly<Record<string, unknown>>> {
  const recorded = await createRecord<RecordedAction>(home, OUTBOX_DIR, (id) => ({ id, action, level, at: now, reason: SANDBOX_ACTION_REASON, ...(run ? { run } : {}) }));
  await appendAudit(home, { ts: now, actor: "engine", event: "action.recorded", ref: action.tool, payload: { outbox_id: recorded.id, level, run: run ?? null } });
  return { status: "recorded", outbox_id: recorded.id, tool: action.tool, level, reason: SANDBOX_ACTION_REASON };
}
/** What the recording sink holds: messages and actions, of one run (`<workflow>/<run_id>`) or all. */
export async function listOutbox(home: string, run?: string): Promise<Readonly<Record<string, unknown>>[]> {
  const isEntry = (value: unknown): value is { readonly id: number; readonly run?: string } => typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "number";
  return (await listRecords(home, OUTBOX_DIR, isEntry)).filter((entry) => run === undefined || entry.run === run);
}
