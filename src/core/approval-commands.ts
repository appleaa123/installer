import { AGENT_CALL_NO_EDIT, approveItem, deciderFor, editItem, getApproval, isAgentCall, listApprovals, refuseDecision, rejectItem, withoutToken, type ApprovalItem } from "./approvals.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { argsOf, prepareAction, requireTool, toolContext } from "./tools.js";
import type { Roles } from "./types.js";

/** `taskfollow approvals list | approve <id> | edit <id> --value <json> | reject <id> [--reason <text>]` (D61). */
export interface ApprovalsCommand {
  readonly sub: string | undefined;
  readonly id: string | undefined;
  readonly as?: string;
  readonly reason?: string;
  readonly value?: string;
  /** stdin is a terminal: a person typed the command (an agent's shell has none). */
  readonly interactive: boolean;
}

const DECISIONS = ["approve", "edit", "reject"];
const USAGE = "approvals needs one of: list, approve <id>, edit <id> --value '<json arguments>', reject <id> [--reason <text>]";

function parseId(text: string | undefined): number {
  if (!text || !/^[1-9]\d*$/.test(text)) throw new InputError(`${USAGE}; <id> is the item number, for example 7`);
  return Number(text);
}

function editedArgs(value: string | undefined): unknown {
  if (value === undefined) throw new InputError("edit needs --value '<json arguments>': the arguments as you want them, for example --value '{\"id\":1,\"text\":\"…\"}'");
  try {
    return JSON.parse(value);
  } catch {
    throw new InputError("--value must be the tool's arguments as JSON");
  }
}

/** What the person sees after deciding; the token stays with the item for the agent's approvals.get. */
function decided(item: ApprovalItem): unknown {
  const next = item.status === "approved" ? `Tell the agent that item ${item.id} is approved: it fetches the token with approvals.get and runs exactly this action` : undefined;
  return { ...withoutToken(item), ...(next ? { next } : {}) };
}

async function decide(home: string, roles: Roles | undefined, command: ApprovalsCommand, now: () => string): Promise<ApprovalItem> {
  const id = parseId(command.id);
  const decider = deciderFor(command.as, roles);
  if (!command.interactive) {
    const reason = `Approvals are decided by a person in their own terminal, not by the agent: open a terminal and run 'taskfollow approvals ${command.sub} ${id}' there`;
    return refuseDecision(home, await getApproval(home, id, now()), decider.name, reason, now(), "agent");
  }
  if (command.sub === "approve") return approveItem(home, id, decider, now());
  if (command.sub === "reject") return rejectItem(home, id, decider, command.reason, now());
  const item = await getApproval(home, id, now());
  if (isAgentCall(item)) return refuseDecision(home, item, decider.name, AGENT_CALL_NO_EDIT, now());
  const ctx = await toolContext(home, "cli", DEFAULT_TOOLS, now);
  const prepared = await prepareAction(ctx, requireTool(DEFAULT_TOOLS, item.action.tool), argsOf(editedArgs(command.value)));
  return editItem(home, id, prepared, decider, now());
}

export async function approvalsCommand(home: string, roles: Roles | undefined, command: ApprovalsCommand, now: () => string): Promise<unknown> {
  if (command.sub === "list") return { items: (await listApprovals(home, now())).map(withoutToken) };
  if (!DECISIONS.includes(command.sub ?? "")) throw new InputError(USAGE);
  return decided(await decide(home, roles, command, now));
}
