import { access, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { confinedPath } from "./actions.js";
import { madeMarker } from "./agent-hook.js";
import { runTask } from "./agent-task.js";
import { actionHash, redeemToken, ToolRefusal, type ApprovalItem, type PreparedAction } from "./approvals.js";
import { canonicalJson } from "./audit.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { auditRun, saveStep, type RunRecord, type StepLog } from "./runs.js";
import { callsFile, profileFor, seal, TASK_INTERRUPTED } from "./task-step.js";
import type { Exec, StepOutcome } from "./runner-steps.js";

/**
 * D151: a person approves one exact call to a tool of their own agent (an MCP tool such as a Shopify product update),
 * and only then may the agent make it, once, with exactly those arguments. The approval item is bound to the call by
 * its hash like any other (D58); it is always L3, so the decision maker decides and earned autonomy never applies
 * (D94: the item has no policy flag). After "yes" the token is spent first, the step is marked as started (a crash
 * stops the run for a person), and the agent runs under the hook's exact mode. Whether the call was made is read from
 * the record and the hook's marker, never from the agent's answer. Nothing is tried again on the same approval.
 */
export const AGENT_CALL_MAX_BYTES = 20_000;
const REASON = "a call to the agent's own tool, outside TaskFollow";
const CALL_TIMEOUT_MS = 5 * 60_000;
const DONE = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false };
const AGAIN = "run the workflow again to ask for a new approval";

/** TaskFollow's own tools are named like `memo.add`; an agent's MCP tool is `mcp__<server>__<tool>`. */
export const isAgentCall = (item: ApprovalItem): boolean => item.action.tool.startsWith("mcp__");

export function prepareAgentCall(step: string, tool: string, args: Readonly<Record<string, unknown>>): PreparedAction {
  if (Buffer.byteLength(canonicalJson(args)) > AGENT_CALL_MAX_BYTES) {
    throw new InputError(`Step '${step}': the call to ${tool} is larger than ${AGENT_CALL_MAX_BYTES / 1000} kB, too large for a person to check; split it into smaller calls`);
  }
  return { tool, args, expected_values: {}, level: "L3", reasons: [REASON], action_hash: actionHash(tool, args, {}) };
}

const callPrompt = (tool: string): string =>
  `A person approved exactly one call to ${tool}. Make that call once, using the input below as its arguments exactly as they are, and make no other call. Then answer {"done": true}, or {"done": false} if it could not be made.`;

/** The record's result lines for the approved tool (refused attempts are not results). */
async function results(path: string, tool: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { tool?: string; outcome?: string })
    .filter((line) => line.tool === tool && (line.outcome === "ok" || line.outcome === "failed")).map((line) => line.outcome ?? "");
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

async function verdict(exec: Exec, record: RunRecord, path: string, tool: string, agentError: string | undefined): Promise<string | null> {
  const [marked, made] = [await exists(madeMarker(path)), await results(path, tool)];
  if (!marked && made.length > 0) {
    await auditRun(exec.home, exec.ctx.now(), "run.agent_call_unchecked", record, { tool });
    return `${tool} ran without TaskFollow's check; see 'taskfollow why --run ${record.run_id}'`;
  }
  if (!marked) return `the agent did not make the approved call${agentError ? ` (${agentError})` : ""}; ${AGAIN}`;
  if (made.length === 0) return `the agent started the approved call but no result was recorded, so it may have been made; check with 'taskfollow why --run ${record.run_id}' before you ${AGAIN}`;
  if (made[0] === "failed") return `the approved call to ${tool} failed; see 'taskfollow why --run ${record.run_id}', then ${AGAIN}`;
  return null;
}

export async function makeApprovedCall(exec: Exec, record: RunRecord, log: StepLog, item: ApprovalItem, token: string): Promise<StepOutcome> {
  const { tool, args } = item.action;
  const stop = async (reason: string): Promise<StepOutcome> => {
    await saveStep(exec.home, record, { ...log, status: "failed", finished_at: exec.ctx.now(), error: reason });
    return { kind: "stop", status: "failed", reason: `step '${log.step}': ${reason}` };
  };
  try {
    const profile = await profileFor(exec);
    await redeemToken(exec.home, token, prepareAgentCall(log.step, tool, args), exec.ctx.now());
    await saveStep(exec.home, record, { ...log, status: "failed", error: TASK_INTERRUPTED });
    const path = await confinedPath(exec.home, callsFile(record, log.step));
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const result = await runTask(exec.home, profile, { prompt: callPrompt(tool), input: args, may_use: [tool], changes: true, output: DONE, timeoutMs: CALL_TIMEOUT_MS, record: path, exact: { tool, args } }, { env: { ...(exec.env ?? process.env) } });
    await seal(exec, record, log.step, path);
    const problem = await verdict(exec, record, path, tool, result.ok ? undefined : result.error);
    if (problem) return stop(problem);
  } catch (error) {
    if (!(error instanceof ToolRefusal || error instanceof ActionFailure || error instanceof InputError)) throw error;
    return stop(error.message);
  }
  const finished = exec.ctx.now();
  await saveStep(exec.home, record, { ...log, status: "done", finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(log.started_at)), output: { made: tool } });
  return { kind: "done", output: { made: tool }, actions: 1, needs_human: 0 };
}
