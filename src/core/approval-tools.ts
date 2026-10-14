import { APPROVAL_STATUSES, getApproval, listApprovals, requestApproval, withoutToken, type ApprovalItem } from "./approvals.js";
import { InputError } from "./inputs.js";
import { argsOf, idArg, onlyKeys, prepareAction, requireTool, textArg, type ToolArgs, type ToolDef } from "./tools.js";

/**
 * The agent's side of the queue: ask, look, fetch the token. Deciding (approve / edit / reject) is
 * never a tool: only a person decides, in their own terminal (D61).
 */

function stringList(value: unknown, what: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new InputError(`approvals.request: '${what}' must be a list of text`);
  return value as string[];
}

function parseRequest(args: ToolArgs): ToolArgs {
  onlyKeys(args, ["tool", "args", "why", "preview", "evidence", "urgent"], "approvals.request");
  if (typeof args.tool !== "string") throw new InputError("approvals.request needs 'tool', the name of the tool to approve");
  if (typeof args.why !== "string") throw new InputError("approvals.request needs 'why': say in one sentence why this action is needed");
  if (args.urgent !== undefined && typeof args.urgent !== "boolean") throw new InputError("approvals.request: 'urgent' must be true or false");
  return {
    tool: args.tool, args: argsOf(args.args ?? {}), why: args.why, evidence: stringList(args.evidence, "evidence"), urgent: args.urgent ?? false,
    ...(args.preview === undefined ? {} : { preview: textArg(args, "preview", "approvals.request") }),
  };
}

const who = (item: ApprovalItem): string => (item.required_role === "decision_maker" ? "the decision maker" : "a team member");

export const APPROVAL_TOOLS: readonly ToolDef[] = [
  {
    name: "approvals.request", meta: true,
    description: "Ask a person to approve one exact call of an L2 or L3 tool. Give the tool, its arguments and why it is needed.",
    fields: { tool: { type: "string" }, args: { type: "object" }, why: { type: "string" }, preview: { type: "string" }, evidence: { type: "array", items: { type: "string" } }, urgent: { type: "boolean" } },
    required: ["tool", "args", "why"],
    parse: parseRequest,
    run: async (ctx, args) => {
      const target = requireTool(ctx.registry, args.tool as string);
      if (target.meta) throw new InputError(`${target.name} needs no approval`);
      const prepared = await prepareAction(ctx, target, args.args as ToolArgs);
      const preview = args.preview as string | undefined;
      const item = await requestApproval(ctx.home, { prepared, why: args.why as string, evidence: args.evidence as string[], urgent: args.urgent as boolean, via: ctx.via, ...(preview ? { preview } : {}) }, ctx.now());
      return { ...withoutToken(item), next: `Ask ${who(item)} to run 'taskfollow approvals approve ${item.id}' in their own terminal (or edit or reject it), then call approvals.get with {"id":${item.id}}` };
    },
  },
  {
    name: "approvals.list", meta: true, description: "List approval items, urgent ones first. Optional status filter.",
    fields: { status: { type: "string", enum: [...APPROVAL_STATUSES] } },
    required: [],
    parse: (args) => {
      onlyKeys(args, ["status"], "approvals.list");
      if (args.status !== undefined && !(APPROVAL_STATUSES as readonly unknown[]).includes(args.status)) throw new InputError(`approvals.list: 'status' must be one of ${APPROVAL_STATUSES.join(", ")}`);
      return args.status === undefined ? {} : { status: args.status };
    },
    run: async (ctx, args) => ({ items: (await listApprovals(ctx.home, ctx.now())).filter((item) => args.status === undefined || item.status === args.status).map(withoutToken) }),
  },
  {
    name: "approvals.get", meta: true, description: "Show one approval item. Once approved it carries the approval_token for that exact call.",
    fields: { id: { type: "integer", minimum: 1 } },
    required: ["id"],
    parse: (args) => {
      onlyKeys(args, ["id"], "approvals.get");
      return { id: idArg(args, "id", "approvals.get") };
    },
    run: async (ctx, args) => {
      const item = await getApproval(ctx.home, args.id as number, ctx.now());
      if (item.status !== "approved" || !item.token) return withoutToken(item);
      return { ...withoutToken(item), approval_token: item.token, next: `Call ${item.action.tool} with exactly the arguments in 'action.args' plus "approval_token"` };
    },
  },
];
