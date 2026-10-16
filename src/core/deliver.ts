import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOKEN_PATTERN } from "./agent-hook.js";
import { listChannels } from "./channels.js";
import { decideHome, type AgentRef } from "./homes.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { loadState } from "./state.js";
import { ENGINE_SECRETS } from "./uninstall.js";
import { REFERENCES_DIR, SKILL_FILE } from "./skills.js";
import { RULES_FILE, rulesMarkdown, skillMarkdown } from "./workflow-skill.js";
import type { Trigger, Workflow } from "./workflow.js";
import { storedZip } from "./zip.js";

/**
 * Delivering a workflow to the agent's own scheduler (spec section 10, D158, D160). For Claude Cowork that is a zip
 * whose single folder has SKILL.md at its top and no plugin manifest (what Cowork accepted in task 32), plus the
 * schedule text to paste in a Cowork chat. The owner's rules go inside SKILL.md, so the zip holds one file. Before
 * anything is written the text is checked: no keychain value, token, channel secret, local path or `taskfollow`
 * command, because it runs where none of them belong. Clean-up in Cowork is by hand in the app.
 */
export const DELIVER_DIR = "taskfollow-deliver";
const LOCAL_PATH = /(\/Users\/|\/home\/|[A-Za-z]:\\|~\/)/;
const COMMAND = /\btaskfollow\s+[a-z]/;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface Delivery {
  readonly zip: string;
  readonly skill: string;
  readonly schedule: string;
  readonly steps: readonly string[];
}

export function scheduleWords(trigger: Trigger): string {
  if (trigger.kind !== "cron") return "every weekday at 08:00, or at the time you prefer";
  const [minute, hour, dom, month, dow] = trigger.cron.split(/\s+/);
  const time = /^\d+$/.test(minute ?? "") && /^\d+$/.test(hour ?? "") ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` : undefined;
  if (time && dom === "*" && month === "*") {
    if (dow === "*") return `every day at ${time} (${trigger.tz})`;
    if (dow === "1-5") return `every weekday at ${time} (${trigger.tz})`;
    if (/^[0-6]$/.test(dow ?? "")) return `every ${DAYS[Number(dow)]} at ${time} (${trigger.tz})`;
  }
  return `on this schedule: ${trigger.cron} (${trigger.tz})`;
}

/** The values that must never travel: every engine keychain item and every channel setting except the person's own address. */
async function forbiddenValues(home: string): Promise<string[]> {
  const values: string[] = [];
  for (const id of ENGINE_SECRETS) {
    const secret = await getSecret(id).catch(() => null);
    if (secret && secret.length >= 8) values.push(secret);
  }
  for (const config of await listChannels(home).catch(() => [])) {
    const own = typeof (config as { address?: unknown }).address === "string" ? (config as { address: string }).address : undefined;
    values.push(...settingValues(config).filter((value) => value !== own));
  }
  return values;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

/** Every string of 8 or more characters in a channel's settings, nested ones included (a bot's name, a mail server), dates aside (review H3). */
function settingValues(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 8 && !ISO_DATE.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(settingValues);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(settingValues);
  return [];
}

/** Refuses text that holds anything that must stay on this computer, naming only the kind, never the value. */
export async function checkDelivered(home: string, text: string): Promise<void> {
  const fail = (kind: string): never => {
    throw new InputError(`This workflow's text holds ${kind}; remove it from the workflow's description or rules, then deliver it again`);
  };
  if ((await forbiddenValues(home)).some((value) => text.includes(value))) fail("a key or a channel setting from this computer");
  if (new RegExp(TOKEN_PATTERN.source).test(text)) fail("something that looks like a key or token");
  if (LOCAL_PATH.test(text)) fail("a path on this computer");
  if (COMMAND.test(text)) fail("a taskfollow command, which does not exist where it will run");
}

const readOr = async (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);

/** The workflow's skill as one SKILL.md: the install folder's skill (item 2) with its rules inside, or one made from the description. */
async function skillText(home: string, workflow: Workflow): Promise<string> {
  const workDir = (await loadState(home))?.work_dir;
  const folder = workDir ? join(workDir, ".claude", "skills", workflow.id) : undefined;
  const skill = folder ? await readOr(join(folder, SKILL_FILE)) : null;
  const rules = folder ? await readOr(join(folder, REFERENCES_DIR, RULES_FILE)) : null;
  const base = skill ?? skillMarkdown(workflow.id, workflow.description);
  return `${base.trimEnd()}\n\n## The owner's own rules\n\n${(rules ?? rulesMarkdown(workflow.id, undefined)).replace(/^# .*\n+/, "").trim()}\n`;
}

export async function writeSkillZip(home: string, name: string, skill: string): Promise<string> {
  const workDir = (await loadState(home))?.work_dir ?? home;
  const dir = join(workDir, DELIVER_DIR);
  await mkdir(dir, { recursive: true });
  const zip = join(dir, `${name}.zip`);
  await writeFile(zip, storedZip([{ name: `${name}/`, data: Buffer.alloc(0) }, { name: `${name}/${SKILL_FILE}`, data: Buffer.from(skill, "utf8") }]));
  return zip;
}

export const coworkCleanUp = (task: string, skill: string): string =>
  `To remove it later: delete the task "${task}" in your Scheduled list, and the skill "${skill}" in Settings, then Skills (Cowork cannot delete them from a chat)`;

/**
 * Delivery is the routing step, so it follows the home decided by code (review B2): only work whose home is the named
 * agent's own scheduler is handed over. Hard-rule or unconfirmed work stays in TaskFollow's runner or draft-only.
 */
export async function deliverToCowork(home: string, workflow: Workflow, options: { readonly now: string; readonly agent: AgentRef; readonly runner: AgentRef }): Promise<Delivery> {
  const decided = await decideHome(home, workflow, { whileAway: true, runner: options.runner, homeAgent: options.agent }, options.now);
  if (decided.home.home !== "agent-scheduler" || decided.home.agent !== options.agent.agent) throw new InputError(`Not delivered: ${decided.why}`);
  const skill = await skillText(home, workflow);
  const schedule = `Set a scheduled task ${scheduleWords(workflow.trigger)}: use the skill ${workflow.id} and do this: ${workflow.description.trim()} Send me a short brief of the result with SendUserMessage, to me only. End the brief with: Sent by your scheduled TaskFollow workflow ${workflow.id}.`;
  await checkDelivered(home, `${skill}\n${schedule}`);
  const zip = await writeSkillZip(home, workflow.id, skill);
  return {
    zip, skill: workflow.id, schedule,
    steps: [
      `In Claude (claude.ai or the app), open Settings, then Skills, and upload ${zip}`,
      "Start a Cowork chat and paste the schedule text",
      "Check that the task shows in your Scheduled list",
      coworkCleanUp(`the task for ${workflow.id}`, workflow.id),
    ],
  };
}
