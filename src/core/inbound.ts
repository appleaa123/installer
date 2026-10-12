import { createHash } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { DEFAULT_POLICY, recordOptOut } from "./channel-policy.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import { isOptOut, joinCodeIn, normalizeInbound, replyCodeIn, type InboundEnvelope, type RawInbound, type ReplyCode } from "./envelope.js";
import { storeInbound, type Route } from "./inbox.js";
import { joinWithCode, memberFor, type Identity, type Member } from "./members.js";
import { loadPinnedSolution } from "./pin.js";
import { acknowledgeByReply } from "./alerts.js";
import { decideByReply } from "./reply-codes.js";
import { invokeTool, type ToolContext } from "./tools.js";

/**
 * The inbound pipeline (spec §12.4, D76): normalise and mark → drop a message handled before → opt-out → join code →
 * identify the sender → a member's reply code decides an approval, a member's other text is a conversation, anyone
 * else's text is an event (the hook for Plan 7's `message.received` triggers). Nothing in a message's text is obeyed:
 * only the three command shapes are read, and only a joined member's reply code can decide anything.
 */
export const SEEN_DIR = join("state", "gateway", "seen");

export type Outcome = "duplicate" | "opted_out" | "joined" | "join_refused" | "decided" | "refused" | Route;

const seenPath = (home: string, envelope: InboundEnvelope): Promise<string> =>
  confinedPath(home, join(SEEN_DIR, createHash("sha256").update(`${envelope.channel}:${envelope.message_id}`).digest("hex")));

/** True when the message was handled to the end before (a restarted gateway reads the same round again). */
export async function seenBefore(home: string, envelope: InboundEnvelope): Promise<boolean> {
  try {
    await access(await seenPath(home, envelope));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Written last, once the message is stored and handled, so a crash before it means the message is read again. */
async function markSeen(home: string, envelope: InboundEnvelope): Promise<void> {
  const path = await seenPath(home, envelope);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** Answers the member on the channel they wrote from. */
const tell = (ctx: ToolContext, member: Member, channel: string, text: string) => invokeTool(ctx, "channel.notify", { member: member.name, text, channel });

async function joinByCode(ctx: ToolContext, envelope: InboundEnvelope, identity: Identity, code: string): Promise<Outcome> {
  await storeInbound(ctx.home, { ...envelope, text: "(join code)" }, "command");
  const result = await joinWithCode(ctx.home, code, identity, ctx.now());
  if ("refused" in result) return "join_refused";
  const as = result.joined.role === "decision_maker" ? "the decision maker" : "a member";
  await tell(ctx, result.joined, identity.channel, `Welcome, ${result.joined.name}: you joined as ${as}. Approval requests arrive here; answer A<number> to approve, R<number> <reason> to reject.`);
  return "joined";
}

/** D78: a channel whose sender can be forged (email) never decides; the member is told where to decide instead. */
async function unverifiedReply(ctx: ToolContext, member: Member, channel: string, code: ReplyCode): Promise<Outcome> {
  const reason = `Approvals cannot be decided by ${channel}, because the sender of a message there can be forged: answer in Telegram, or run 'installer approvals approve ${code.id}' in a terminal`;
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "human", event: "approval.refused", ref: `approval:${code.id}`, payload: { id: code.id, by: member.name, reason } });
  await tell(ctx, member, channel, reason);
  return "refused";
}

/** A reply code from someone who is not a joined member decides nothing; the attempt is audited (§11.9). */
async function strangerCode(ctx: ToolContext, envelope: InboundEnvelope): Promise<void> {
  const code = replyCodeIn(envelope.text);
  if (!code) return;
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "human", event: "approval.refused", ref: `approval:${code.id}`, payload: { id: code.id, by: `unknown ${envelope.channel} sender`, reason: "not a joined member" } });
}

/** Drops a message handled before; otherwise routes it and only then marks it seen (storing is idempotent). */
export async function handleInbound(ctx: ToolContext, raw: RawInbound): Promise<Outcome> {
  const envelope = normalizeInbound(raw, ctx.now());
  if (await seenBefore(ctx.home, envelope)) return "duplicate";
  const outcome = await routeInbound(ctx, envelope);
  await markSeen(ctx.home, envelope);
  return outcome;
}

async function routeInbound(ctx: ToolContext, envelope: InboundEnvelope): Promise<Outcome> {
  const identity = { channel: envelope.channel, address: envelope.from };
  const policy = (await loadPinnedSolution(ctx.home)).solution.channel_policy ?? DEFAULT_POLICY;
  if (isOptOut(envelope.text, policy.opt_out_keywords)) {
    await storeInbound(ctx.home, envelope, "command");
    if (await recordOptOut(ctx.home, identity, ctx.now())) await appendAudit(ctx.home, { ts: ctx.now(), actor: "human", event: "channel.opted_out", ref: envelope.channel, payload: identity });
    return "opted_out";
  }
  const code = joinCodeIn(envelope.text);
  if (code) return joinByCode(ctx, envelope, identity, code);
  const member = await memberFor(ctx.home, identity, ctx.now());
  const reply = member ? replyCodeIn(envelope.text) : null;
  if (member && reply) {
    await storeInbound(ctx.home, envelope, "command", member.name);
    if (!CHANNEL_FACTS[requireChannelId(envelope.channel)].risk.sender_verified) return unverifiedReply(ctx, member, envelope.channel, reply);
    await tell(ctx, member, envelope.channel, reply.decision === "acknowledge" ? await acknowledgeByReply(ctx, member, reply.id) : await decideByReply(ctx, member, reply));
    return "decided";
  }
  if (!member) await strangerCode(ctx, envelope);
  const route: Route = member ? "conversation" : "event";
  const item = await storeInbound(ctx.home, envelope, route, member?.name);
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "engine", event: "channel.received", ref: `inbox:${item.id}`, payload: { channel: envelope.channel, route, injection: envelope.injection } });
  return route;
}
