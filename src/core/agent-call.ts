import { actionHash, type PreparedAction } from "./approvals.js";
import { canonicalJson } from "./audit.js";
import { InputError } from "./inputs.js";

/**
 * D151: a person approves one exact call to a tool of their own agent (an MCP tool such as a Shopify product update),
 * and only then may the agent make it, once, with exactly those arguments. The approval item is bound to the call by
 * its hash like any other (D58); it is always L3, so the decision maker decides and earned autonomy never applies
 * (D94: the item has no policy flag).
 */
export const AGENT_CALL_MAX_BYTES = 20_000;
const REASON = "a call to the agent's own tool, outside TaskFollow";

export function prepareAgentCall(step: string, tool: string, args: Readonly<Record<string, unknown>>): PreparedAction {
  if (Buffer.byteLength(canonicalJson(args)) > AGENT_CALL_MAX_BYTES) {
    throw new InputError(`Step '${step}': the call to ${tool} is larger than ${AGENT_CALL_MAX_BYTES / 1000} kB, too large for a person to check; split it into smaller calls`);
  }
  return { tool, args, expected_values: {}, level: "L3", reasons: [REASON], action_hash: actionHash(tool, args, {}) };
}
