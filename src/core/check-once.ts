import { agentOf, type CheckContext } from "./check-commands.js";
import { startChallenge } from "./checks.js";
import { InputError } from "./inputs.js";
import { runCommand } from "./run-commands.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { runResult } from "./why.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * The work done once, before any test (spec principle 1, plan Task 7). With TaskFollow's runner the workflow runs once
 * in sandbox, so nothing is sent or changed and the gate holds; when the agent did it in the chat instead, it must have
 * read and drafted only. Either way the person says on their page whether they saw it and whether it was right.
 */
export const ONCE_TTL_MS = 60 * 60_000;
type Raw = Record<string, unknown>;

function byChat(value: string | undefined): boolean {
  if (value === undefined) return false;
  try {
    const parsed = JSON.parse(value) as Raw;
    return parsed.by === "chat";
  } catch {
    throw new InputError(`check once: --value must be JSON, for example '{"by":"chat"}'`);
  }
}

export async function onceCommand(home: string, state: InstallState | undefined, id: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const chat = byChat(typeof flags.value === "string" ? flags.value : undefined);
  let ran: Raw | undefined;
  if (!chat) {
    const run = await runCommand(home, workflow.id, true, context.now);
    const result = await runResult(home, String(run.run_id));
    ran = { run_id: run.run_id, status: run.status, sandbox: run.sandbox, ...(result ? { result } : {}) };
  }
  const { agent, version } = agentOf(state, undefined);
  const { challenge } = await startChallenge(home, { needs: ["answers"], test: "once", workflow: workflow.id, agent, agentVersion: version, ttlMs: ONCE_TTL_MS }, context.now());
  const launched = await context.launch(home, challenge.id, undefined);
  const page = launched.opened ? "opened in the person's browser: show them the result, then ask them to answer there" : `ask the person to run 'taskfollow check page ${challenge.id}' in their own terminal`;
  return {
    id: challenge.id, test: "once", ...(ran ? { ran } : { note: "You did the work in the chat: it must have been read and draft only (nothing sent, written or deleted). Show the person the draft." }), page,
  };
}
