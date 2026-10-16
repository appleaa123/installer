import { agentOf, CHECK_TTL_MS, type CheckContext } from "./check-commands.js";
import { plantAndAudit, plantByChannel, SUBJECT_PREFIX } from "./check-plant.js";
import { openChallenge, settleByPerson, startChallenge, type Need } from "./checks.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

export { plantByChannel, SUBJECT_PREFIX, subjectFor } from "./check-plant.js";

/**
 * T2, reading email (spec 5.2, plan Task 8, D160). When TaskFollow has its own email channel, it plants the test
 * email itself, to the channel's own address only, so the word is on no page and nobody sees it until the agent finds
 * it. That is a self-addressed test, not a message to a person, so it does not go through `deliver` (D79): the
 * connector's own send, audited without the word. Otherwise the person's page shows the subject to send themselves.
 */
const NEEDS: readonly Need[] = ["reads:email"];
type Raw = Record<string, unknown>;

export const answerInstruction = (id: string): string =>
  `Find the newest email whose subject starts with "${SUBJECT_PREFIX} ${id}" and run: taskfollow check answer ${id} '<the rest of that subject, after ${id}>'. If you cannot read email, run: taskfollow check cannot ${id}`;

export async function startReadsEmail(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
  const { challenge, word } = await startChallenge(home, { needs: NEEDS, test: "t2", ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  if (await plantAndAudit(home, context.plant ?? plantByChannel, challenge.id, word ?? "", "t2", context.now())) {
    return { id: challenge.id, test: "t2", instruction: answerInstruction(challenge.id), planted: "TaskFollow sent the test email to your own address; give it a minute to arrive" };
  }
  const launched = await context.launch(home, challenge.id, word);
  return {
    id: challenge.id, test: "t2", instruction: answerInstruction(challenge.id),
    page: launched.opened ? "opened in the person's browser: they send themselves the test email from there, then tell you" : `ask the person to run 'taskfollow check page ${challenge.id}' in their own terminal`,
  };
}

/** The agent says it cannot read email: not an ability verdict, and none of its words are kept. */
export async function cannotCommand(home: string, id: string | undefined, now: string): Promise<Raw> {
  const challenge = await openChallenge(home, id ?? "", now);
  const reason = "Blocked, not an ability problem: your assistant said it cannot reach your email yet (it may need an email connection, such as Gmail in its settings)";
  await settleByPerson(home, challenge, challenge.needs.map((need) => ({ need, result: "not-checked" as const, reason })), now);
  return { need: challenge.needs[0] ?? "reads:email", result: "not checked", why: reason };
}
