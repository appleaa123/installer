import { join } from "node:path";
import { approveItem, editItem, getApproval, listApprovals, refuseDecision, rejectItem, type ApprovalItem, type Decider } from "./approvals.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import type { ReplyCode } from "./envelope.js";
import { InputError } from "./inputs.js";
import { roleAtLeast } from "./levels.js";
import { listMembers, type Member } from "./members.js";
import { claimOnce } from "./numbered.js";
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

const decided = (item: ApprovalItem): string => `Approval ${item.id} is ${item.status}${item.decision?.decision === "edited" ? " as edited" : ""}.`;

async function edit(ctx: ToolContext, item: ApprovalItem, decider: Decider, text: string): Promise<ApprovalItem> {
  const current = item.action.args.text;
  if (typeof current !== "string") {
    return refuseDecision(ctx.home, item, decider.name, `Approval ${item.id} has no text to replace: edit it in a terminal with 'installer approvals edit ${item.id} --value <json>'`, ctx.now());
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
    return decided(await edit(ctx, item, decider, code.text));
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
}

function announcement(item: ApprovalItem): string {
  const editable = typeof item.action.args.text === "string" ? `, or E${item.id} <new text> to change the text` : "";
  const text = `${item.urgent ? "URGENT " : ""}Approval ${item.id} (${item.level}): ${item.preview}\nWhy: ${item.why}\nReply A${item.id} to approve, R${item.id} <reason> to reject${editable}. It expires at ${item.expires_at}.`;
  return text.slice(0, MAX_TEXT);
}

const canDecideThere = (member: Member): boolean => member.identity !== undefined && CHANNEL_FACTS[requireChannelId(member.identity.channel)].risk.sender_verified;

/** Sends each pending item, once, to the joined members whose role may decide it; returns the ids announced. */
export async function announceApprovals(ctx: ToolContext): Promise<number[]> {
  const members = (await listMembers(ctx.home, ctx.now())).filter((member) => member.status === "joined" && canDecideThere(member));
  const announced: number[] = [];
  for (const item of (await listApprovals(ctx.home, ctx.now())).filter((entry) => entry.status === "pending")) {
    const targets = new Map(members.filter((member) => roleAtLeast(member.role, item.required_role)).map((member) => [`${member.name}\n${member.identity?.channel}`, member]));
    if (targets.size === 0 || !(await claimOnce(ctx.home, ANNOUNCED_DIR, item.id))) continue;
    for (const member of targets.values()) await invokeTool(ctx, "channel.notify", { member: member.name, text: announcement(item), channel: member.identity?.channel });
    announced.push(item.id);
  }
  return announced;
}
