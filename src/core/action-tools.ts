import { onlyKeys, textArg, type ToolDef } from "./tools.js";

/**
 * `actions.reason` (D137): a task step's agent states, before an action, which tool it is about to use and why. The
 * tool only acknowledges; the step's hook records the call (with the reason) in the step's record, where
 * `taskfollow why` pairs it with the next call of that tool.
 */
export const ACTION_TOOLS: readonly ToolDef[] = [
  {
    name: "actions.reason", meta: true,
    description: "Before an action, say which tool you are about to use and, in one sentence, why. Your reason is kept with the record of the call.",
    fields: { tool: { type: "string" }, why: { type: "string" } },
    required: ["tool", "why"],
    parse: (args) => {
      onlyKeys(args, ["tool", "why"], "actions.reason");
      return { tool: textArg(args, "tool", "actions.reason"), why: textArg(args, "why", "actions.reason") };
    },
    run: async () => ({ noted: true }),
  },
];
