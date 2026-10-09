import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { loadChannel, openChannel, type ChannelId, type OutboundMessage } from "./channels.js";
import { InputError } from "./inputs.js";
import { createRecord } from "./numbered.js";
import { loadPinnedSolution } from "./pin.js";
import { buildReport } from "./report.js";
import { loadState } from "./state.js";

/**
 * R6, D79: no real outbound message during the install. Every message the engine sends goes through `deliver`,
 * which sends it only when the install is finished (the report says ready, or ready with limits) and the channel
 * was verified by `installer channel`; otherwise it is recorded in `sandbox/outbox/` (the recording sink, §4.2)
 * and audited. No exception, not even for a join confirmation. Plan 8 owns full sandbox mode and dry runs.
 */
export const OUTBOX_DIR = join("sandbox", "outbox");

export type Delivery = { readonly status: "sent" } | { readonly status: "recorded"; readonly outbox_id: number; readonly reason: string };

type Recorded = OutboundMessage & {
  readonly id: number;
  readonly channel: ChannelId;
  readonly at: string;
  readonly reason: string;
};

type Env = Readonly<Record<string, string | undefined>>;

/** Why a real send is not allowed yet, or null when it is. */
export async function outboundBlock(home: string): Promise<string | null> {
  const state = await loadState(home);
  if (!state) return "there is no install in this home";
  const overall = buildReport((await loadPinnedSolution(home)).solution, state).overall;
  return overall === "ready" || overall === "ready_with_limits" ? null : "the install is not finished, so messages are recorded, not sent (R6)";
}

export const SANDBOX_REASON = "a sandbox run: messages are recorded, never sent (D90)";

export async function deliver(home: string, channel: ChannelId, message: OutboundMessage, now: string, env: Env = process.env, sandbox = false): Promise<Delivery> {
  if (!(await loadChannel(home, channel))) throw new InputError(`The ${channel} channel is not set up: run 'installer channel ${channel}' first`);
  const reason = sandbox ? SANDBOX_REASON : await outboundBlock(home);
  if (reason !== null) {
    const recorded = await createRecord<Recorded>(home, OUTBOX_DIR, (id) => ({ id, channel, ...message, at: now, reason }));
    await appendAudit(home, { ts: now, actor: "engine", event: "channel.recorded", ref: channel, payload: { outbox_id: recorded.id, reason } });
    return { status: "recorded", outbox_id: recorded.id, reason };
  }
  await (await openChannel(home, channel, env)).send(message);
  await appendAudit(home, { ts: now, actor: "engine", event: "channel.sent", ref: channel, payload: { to: message.to } });
  return { status: "sent" };
}
