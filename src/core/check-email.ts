import { appendAudit } from "./audit.js";
import { agentOf, CHECK_TTL_MS, type CheckContext } from "./check-commands.js";
import { loadChannel, openChannel } from "./channels.js";
import { openChallenge, settleByPerson, startChallenge, type Need } from "./checks.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * T2, reading email (spec 5.2, plan Task 8, D160). When TaskFollow has its own email channel, it plants the test
 * email itself, to the channel's own address only, so the word is on no page and nobody sees it until the agent finds
 * it. That is a self-addressed test, not a message to a person, so it does not go through `deliver` (D79): the
 * connector's own send, audited without the word. Otherwise the person's page shows the subject to send themselves.
 */
export const SUBJECT_PREFIX = "TASKFOLLOW-CHECK";
const NEEDS: readonly Need[] = ["reads:email"];
const BODY = "This is a test email from TaskFollow, sent to your own address to check that your assistant can read your email. You can delete it.";
type Raw = Record<string, unknown>;

/** TaskFollow's own plant: its email channel's send, to that channel's own address, nothing else. */
export async function plantByChannel(home: string, subject: string, text: string): Promise<boolean> {
  const config = await loadChannel(home, "email");
  if (!config || config.channel !== "email") return false;
  await (await openChannel(home, "email")).send({ to: config.address, subject, text });
  return true;
}

export const subjectFor = (id: string, word: string): string => `${SUBJECT_PREFIX} ${id} ${word}`;

export const answerInstruction = (id: string): string =>
  `Find the newest email whose subject starts with "${SUBJECT_PREFIX} ${id}" and run: taskfollow check answer ${id} '<the rest of that subject, after ${id}>'. If you cannot read email, run: taskfollow check cannot ${id}`;

export async function startReadsEmail(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
  const { challenge, word } = await startChallenge(home, { needs: NEEDS, test: "t2", ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  const subject = subjectFor(challenge.id, word ?? "");
  const plant = context.plant ?? plantByChannel;
  if (await plant(home, subject, BODY)) {
    await appendAudit(home, { ts: context.now(), actor: "engine", event: "check.planted", ref: `check:${challenge.id}`, payload: { test: "t2", to: "the channel's own address" } });
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
