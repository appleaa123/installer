import { join } from "node:path";
import { AGENT_CALL_NO_EDIT, approveItem, editItem, getApproval, isAgentCall, listApprovals, previewOf, refuseDecision, rejectItem, type ApprovalItem, type Decider } from "./approvals.js";
import { canonicalJson } from "./audit.js";
import { isOptedOut } from "./channel-policy.js";
import { GATEWAY_MARK } from "./channel-tools.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import type { ReplyCode } from "./envelope.js";
import { InputError } from "./inputs.js";
import { roleAtLeast } from "./levels.js";
import { listMembers, type Member } from "./members.js";
import { claimOnce, isClaimed } from "./numbered.js";
import { outboundBlock, type Delivery } from "./outbound.js";
import { MAX_TEXT, invokeTool, prepareAction, requireTool, type ToolContext } from "./tools.js";

/**
 * Approvals from a channel (spec §11.9, D78): a joined member answers `A42`, `R42 <reason>` or `E42 <new text>`;
 * the decision is Plan 4's (same single-use tokens, hashes, roles and audit lines), the decider is the member the
 * channel identity was bound to by `invite`, never the text of the message. `E42` replaces the action's `text`
 * argument, so it works for tools that send a text (channel.send); anything else is edited in the terminal.
 * The gateway announces each pending item once to every member whose role may decide it, on the channels where
 * a reply code can decide (the sender is verified: Telegram, not email).
 */
export const ANNOUNCED_DIR = join("state", "gateway", "announced");
/** Items recorded in sandbox/outbox while the install was not finished (R6), so they are recorded once. */
export const RECORDED_DIR = join("state", "gateway", "announced-recorded");
const CUT = " [cut: see it whole with 'taskfollow approvals list']";

const decided = (item: ApprovalItem): string => `Approval ${item.id} is ${item.status}${item.decision?.decision === "edited" ? " as edited" : ""}.`;

async function edit(ctx: ToolContext, item: ApprovalItem, decider: Decider, text: string): Promise<ApprovalItem> {
  const current = item.action.args.text;
  if (typeof current !== "string") {
    return refuseDecision(ctx.home, item, decider.name, `Approval ${item.id} has no text to replace: edit it in a terminal with 'taskfollow approvals edit ${item.id} --value <json>'`, ctx.now());
  }
  if (text === "") return refuseDecision(ctx.home, item, decider.name, `E${item.id} needs the new text after the code, for example: E${item.id} Thanks, see you Tuesday`, ctx.now());
  const prepared = await prepareAction(ctx, requireTool(ctx.registry, item.action.tool), { ...item.action.args, text });
  return editItem(ctx.home, item.id, prepared, decider, ctx.now());
}

/** Decides one item and says what happened, or why not, in words for the member's chat. */
export async function decideByReply(ctx: ToolContext, member: Member, code: ReplyCode): Promise<string> {
  const decider: Decider = { name: member.name, role: member.role };
  try {
    const item = await getApproval(ctx.home, code.id, ctx.now());
    if (!roleAtLeast(member.role, item.required_role)) {
      return await refuseDecision(ctx.home, item, member.name, `Approval ${item.id} is ${item.level} and needs the decision maker; it was not decided`, ctx.now());
    }
    if (code.decision === "approve") return decided(await approveItem(ctx.home, item.id, decider, ctx.now()));
    if (code.decision === "reject") return decided(await rejectItem(ctx.home, item.id, decider, code.text || undefined, ctx.now()));
    if (isAgentCall(item)) return await refuseDecision(ctx.home, item, member.name, AGENT_CALL_NO_EDIT, ctx.now());
    return decided(await edit(ctx, item, decider, code.text));
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
}

/** The engine's own view of the action, from the item's tool and arguments, never from the agent's words. */
function whatWillHappen({ tool, args }: ApprovalItem["action"]): string {
  if (tool !== "channel.send") return `${tool} ${canonicalJson(args)}`;
  const subject = typeof args.subject === "string" ? `\nSubject: ${args.subject}` : "";
  return `send a ${String(args.channel)} message to ${String(args.to)}${subject}\nText: ${String(args.text)}`;
}

/**
 * The gateway's mark, the decision codes, what will happen (the engine's view), then the agent's preview and why,
 * labelled as the agent's. A text too long for one message is cut, and says so.
 */
export function announcement(item: ApprovalItem): string {
  const editable = typeof item.action.args.text === "string" && !isAgentCall(item) ? `, or E${item.id} <new text> to change the text` : "";
  const preview = item.preview === previewOf(item.action) ? "" : `\nThe agent says: ${item.preview}`;
  const text = `${GATEWAY_MARK} ${item.urgent ? "URGENT " : ""}Approval ${item.id} (${item.level}). Reply A${item.id} to approve, R${item.id} <reason> to reject${editable}. It expires at ${item.expires_at}.
What will happen: ${whatWillHappen(item.action)}${preview}\nWhy, as the agent says: ${item.why}`;
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - CUT.length)}${CUT}`;
}

export const canDecideThere = (member: Member): boolean => member.identity !== undefined && CHANNEL_FACTS[requireChannelId(member.identity.channel)].risk.sender_verified;

/** Tells each member on their own; one member who cannot be reached never stops the others. */
export async function tellEach(ctx: ToolContext, item: ApprovalItem, targets: Iterable<Member>, text = announcement(item)): Promise<{ sent: boolean; error: unknown }> {
  let sent = false;
  let error: unknown = null;
  for (const member of targets) {
    try {
      const result = await invokeTool(ctx, "channel.notify", { member: member.name, text, channel: member.identity?.channel });
      sent ||= (result.deliveries as readonly Delivery[]).some((delivery) => delivery.status === "sent");
    } catch (caught) {
      error ??= caught;
    }
  }
  return { sent, error };
}

/**
 * Sends each pending item to the joined members whose role may decide it, except those who opted out (they are
 * skipped, not tried, so a refusal is not retried and audited every round); returns the ids announced. An item counts
 * as announced only once a member really received it, so a failed send is tried again next round; while the install
 * is not finished (R6) it is recorded once, and sent for real once the install is finished. The first failure is
 * thrown after every item was tried, so the gateway logs it.
 */
export async function announceApprovals(ctx: ToolContext): Promise<number[]> {
  const joined = (await listMembers(ctx.home, ctx.now())).filter((member) => member.status === "joined" && canDecideThere(member));
  const optedOut = await Promise.all(joined.map((member) => (member.identity ? isOptedOut(ctx.home, member.identity) : true)));
  const members = joined.filter((_, index) => !optedOut[index]);
  const recordOnly = (await outboundBlock(ctx.home)) !== null;
  const announced: number[] = [];
  let failure: unknown = null;
  for (const item of (await listApprovals(ctx.home, ctx.now())).filter((entry) => entry.status === "pending")) {
    const targets = new Map(members.filter((member) => roleAtLeast(member.role, item.required_role)).map((member) => [`${member.name}\n${member.identity?.channel}`, member]));
    if (targets.size === 0 || (await isClaimed(ctx.home, ANNOUNCED_DIR, item.id))) continue;
    if (recordOnly && !(await claimOnce(ctx.home, RECORDED_DIR, item.id))) continue;
    const { sent, error } = await tellEach(ctx, item, targets.values());
    failure ??= error;
    if (recordOnly || (sent && (await claimOnce(ctx.home, ANNOUNCED_DIR, item.id)))) announced.push(item.id);
  }
  if (failure !== null) throw failure;
  return announced;
}
