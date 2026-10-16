import { agentOf, type CheckContext } from "./check-commands.js";
import { loadChannel } from "./channels.js";
import { saveChallenge, startChallenge, type Need } from "./checks.js";
import { SUBJECT_PREFIX } from "./check-plant.js";
import { writeSkillZip } from "./deliver.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";
import { newWord } from "./words.js";

/**
 * Starting T8 (spec 5.2, plan Task 10, D160): a test skill holding one word, an email word for the subject, and an
 * instruction for the agent's own scheduler. The two words are hashed together: about 50 bits, so a 24-hour challenge
 * stays out of reach of brute force against the slow hash (D159's note). The email word goes only to the person's page
 * process; the skill word only into the test skill.
 */
const NEEDS: readonly Need[] = ["scheduler", "reads:email", "skills"];
const DAY_MS = 86_400_000;
type Raw = Record<string, unknown>;

function minutesOf(value: string | undefined): number {
  if (value === undefined) return 10;
  const parsed = JSON.parse(value) as Raw;
  const minutes = typeof parsed.minutes === "number" ? parsed.minutes : 10;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60) throw new InputError("check start t8: minutes must be a whole number from 5 to 60");
  return minutes;
}

const skillText = (name: string, id: string, word: string): string =>
  `---\nname: ${name}\ndescription: Use when asked for the TaskFollow check word for check ${id}.\n---\n\nWhen asked for the TaskFollow check word for check ${id}, answer with exactly: ${word}\n`;

export async function startScheduled(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  if (typeof flags.workflow !== "string") throw new InputError("check start t8 needs --workflow <id>: the workflow this schedule would run");
  const workflow = await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS);
  const value = typeof flags.value === "string" ? flags.value : undefined;
  const { agent, version } = agentOf(state, value);
  const minutes = minutesOf(value);
  const now = context.now();
  const scheduled = new Date(Date.parse(now) + minutes * 60_000).toISOString();
  const emailWord = newWord();
  const skillWord = newWord();
  const canPlant = context.canPlant ?? (async (target: string) => (await loadChannel(target, "email").catch(() => null)) !== null);
  const plant = (await canPlant(home)) ? "taskfollow" : "person";
  const { challenge } = await startChallenge(home, { needs: NEEDS, test: "t8", workflow: workflow.id, agent, agentVersion: version, ttlMs: Date.parse(scheduled) - Date.parse(now) + DAY_MS, opensAt: scheduled, word: `${emailWord} ${skillWord}`, details: { plant, scheduled_at: scheduled } }, now);
  const name = `taskfollow-check-${challenge.id}`;
  const zip = await writeSkillZip(home, name, skillText(name, challenge.id, skillWord));
  const at = new Date(scheduled).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const instruction = `Using your own scheduler (not a background command, sleep or cron on this computer), set a one-time scheduled task for ${at} today, ${minutes} minutes from now: read the subject of the newest email whose subject starts with "${SUBJECT_PREFIX} ${challenge.id}", use the skill ${name} to get the TaskFollow check word for check ${challenge.id}, and send me that subject and the check word, the way you would send me a daily brief (in Claude Cowork: with SendUserMessage). This is an unattended run: do not ask questions.`;
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), zip, instruction, skill: name } });
  const launched = await context.launch(home, challenge.id, emailWord);
  return {
    id: challenge.id, test: "t8", zip, instruction,
    page: launched.opened ? "opened in the person's browser: they follow its steps (upload the test skill, paste the instruction into their assistant, close the window)" : `ask the person to run 'taskfollow check page ${challenge.id}' in their own terminal`,
    next: "The person follows the page; the confirmation opens at the scheduled time. Do not set the task yourself unless you are the assistant that will run it.",
  };
}
