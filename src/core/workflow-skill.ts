import { appendFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readSection, removeSection, sectionText, writeSection, type WorkflowLine } from "./agent-file.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { loadProfileById, type RuntimeProfile } from "./profile.js";
import { DISCOVERY_SKILL, REFERENCES_DIR, SKILL_FILE, skillRoots, type SkillRoots } from "./skills.js";
import { loadState } from "./state.js";
import { removeNotesFolder } from "./task-files.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * Workflow skills (9.5, 9.12 item 2, D154): `workflow add` writes the workflow's own skill folder into the agent's
 * skills folder in the install folder (`SKILL.md` + `references/my-rules.md` from the interview) and keeps the
 * `CLAUDE.md` section current. What TaskFollow wrote is recorded in `state/written.json`, so uninstall removes exactly
 * that and nothing else (9.13 item 5).
 */
export const WRITTEN_FILE = join("state", "written.json");
export const RULES_FILE = "my-rules.md";
export const EXAMPLES_FILE = "examples.md";
const DESCRIPTION_LIMIT = 300;

export interface WrittenFolder {
  readonly workflow: string;
  readonly path: string;
  /** The agent's project skills folder when the folder was written; uninstall removes only inside it. */
  readonly root: string;
}
export interface Written {
  readonly skill_folders: readonly WrittenFolder[];
  readonly agent_file?: { readonly path: string; readonly created: boolean };
  /** D171: the install folder's meeting-notes/ (its real path), and whether TaskFollow made it. */
  readonly notes_folder?: { readonly path: string; readonly created: boolean };
}

export async function loadWritten(home: string): Promise<Written> {
  const raw = (await readConfig(home, WRITTEN_FILE)) as Written | null;
  return raw ?? { skill_folders: [] };
}

export const saveWritten = (home: string, written: Written): Promise<void> => writeConfig(home, WRITTEN_FILE, written);

/** The install's agent and its folders; nothing when no agent was found yet. */
export async function installTargets(home: string): Promise<{ readonly profile?: RuntimeProfile; readonly roots: SkillRoots; readonly agentFile: string | null }> {
  const state = await loadState(home);
  if (!state?.runtime?.profile) return { roots: {}, agentFile: null };
  const profile = await loadProfileById(state.runtime.profile);
  const roots = skillRoots(profile, state.work_dir, process.env);
  const agentFile = state.work_dir && profile.instructions_file && !roots.home_folder ? join(state.work_dir, profile.instructions_file) : null;
  return { profile, roots, agentFile };
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…` : flat;
};

export function skillMarkdown(id: string, description: string): string {
  const short = oneLine(description).replace(/[.!?…]$/, "");
  return [
    "---",
    `name: ${id}`,
    `description: Use for the owner's "${id}" work, which TaskFollow also runs as a workflow: ${short}. Use it whenever this work comes up, in chat or in a run.`,
    "---",
    "",
    `# ${id}`,
    "",
    description.trim(),
    "",
    "## The owner's own rules",
    "",
    `Read \`${REFERENCES_DIR}/${RULES_FILE}\` first. The owner's rules there win over anything general here.`,
    "",
    "## Always ask a person first",
    "",
    "Before sending anything to a customer, paying or committing money, anything legal, and deleting anything, ask the owner and wait for a yes, however sure you are.",
    "",
  ].join("\n");
}

/** The rules file's placeholder; the first rule added replaces exactly this line (item 8). */
export const NO_RULES_YET = "None yet. When the owner corrects a result, the agent proposes a rule here and adds it only after the owner says yes.";

export function rulesMarkdown(id: string, rules: string | undefined): string {
  const body = rules?.trim() || NO_RULES_YET;
  return `# My rules for ${id}\n\n${body}\n`;
}

/** 9.6: a few of the owner's real past items with what they expect, rerun in chat when the skill or the rules change. */
export function examplesMarkdown(id: string, examples: string | undefined): string {
  const body = examples?.trim() || "None yet. In the interview, ask the owner for two or three real past items, shortened, and what they expect for each.";
  return `# Examples for ${id}\n\n${body}\n`;
}

/** Item 5: the skill TaskFollow ships for a shape (`solutions/shapes/<id>/SKILL.md`), or null when it ships none. */
export async function shippedSkill(id: string): Promise<string | null> {
  return readFile(fileURLToPath(new URL(`../../solutions/shapes/${id}/${SKILL_FILE}`, import.meta.url)), "utf8").catch(() => null);
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

/** The folder the workflow's own skill goes into, refused when the agent already has a skill folder of that name. */
export async function plannedSkillFolder(roots: SkillRoots, id: string): Promise<string | null> {
  if (!roots.project) return null;
  const folder = join(roots.project, id);
  if (await exists(folder)) throw new InputError(`Your agent already has a skill folder named '${id}' (${folder}); choose another workflow name`);
  return folder;
}

export { DISCOVERY_SKILL };

/**
 * At the start of the WORKFLOWS phase (and again after a consult, `add install`): the discovery skill goes into the
 * agent's project skills folder, recorded with the workflow skills so uninstall and the consult clean-up remove it.
 * An agent without a known skills folder gets it under the home's exports, for the agent to read from there. A folder
 * of that name the person already has is left as it is.
 */
export async function writeDiscoverySkill(home: string): Promise<{ readonly path: string; readonly kept_theirs: boolean }> {
  const text = await readFile(fileURLToPath(new URL(`../../solutions/skills/${DISCOVERY_SKILL}/${SKILL_FILE}`, import.meta.url)), "utf8");
  const { roots } = await installTargets(home);
  if (!roots.project) {
    const file = join(home, (await import("./uninstall.js")).EXPORTS_DIR, DISCOVERY_SKILL, SKILL_FILE);
    await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
    await writeFile(file, text, { mode: 0o600 });
    return { path: file, kept_theirs: false };
  }
  const folder = join(roots.project, DISCOVERY_SKILL);
  const written = await loadWritten(home);
  const recorded = written.skill_folders.some((entry) => entry.workflow === DISCOVERY_SKILL);
  // A folder of that name TaskFollow did not record is the person's own: left as it is, and said so (review of PR #62).
  if (await exists(folder)) return { path: join(folder, SKILL_FILE), kept_theirs: !recorded };
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, SKILL_FILE), text, { flag: "wx" });
  if (!recorded) await saveWritten(home, { ...written, skill_folders: [...written.skill_folders, { workflow: DISCOVERY_SKILL, path: folder, root: roots.project }] });
  return { path: join(folder, SKILL_FILE), kept_theirs: false };
}

export async function writeWorkflowSkill(folder: string, id: string, description: string, rules: string | undefined, extra: { readonly shipped?: string | null; readonly examples?: string } = {}): Promise<void> {
  await mkdir(join(folder, REFERENCES_DIR), { recursive: true });
  await writeFile(join(folder, SKILL_FILE), extra.shipped ?? skillMarkdown(id, description), { flag: "wx" });
  await writeFile(join(folder, REFERENCES_DIR, RULES_FILE), rulesMarkdown(id, rules), { flag: "wx" });
  await writeFile(join(folder, REFERENCES_DIR, EXAMPLES_FILE), examplesMarkdown(id, extra.examples), { flag: "wx" });
}

/** Every current workflow as a line of the section, with `extra` (one not written yet) in its place. */
async function workflowLines(home: string, extra?: WorkflowLine): Promise<WorkflowLine[]> {
  const lines: WorkflowLine[] = [];
  for (const id of await workflowIds(home)) {
    if (id === extra?.workflow) continue;
    try {
      const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
      lines.push({ workflow: id, description: workflow.description, skills: workflow.skills });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return [...lines, ...(extra ? [extra] : [])].sort((a, b) => a.workflow.localeCompare(b.workflow));
}

/** Rewrites the section from the workflows on disk (and `extra`); returns the file written, or null for an agent without one. */
export async function refreshAgentFile(home: string, extra?: WorkflowLine): Promise<string | null> {
  const { agentFile } = await installTargets(home);
  const state = await loadState(home);
  if (!agentFile || !state?.work_dir) return null;
  const { created } = await writeSection(agentFile, sectionText(await workflowLines(home, extra), state.work_dir));
  const written = await loadWritten(home);
  await saveWritten(home, { ...written, agent_file: { path: agentFile, created: written.agent_file?.created ?? created } });
  return agentFile;
}

/** The agent file's text before a change (null when absent), refusing a broken section before anything is written. */
export const agentFileBefore = async (agentFile: string | null): Promise<string | null> => (agentFile ? readSection(agentFile) : null);

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Item 8: the rules file of the skill folder TaskFollow wrote for `workflow`, as recorded and as it really is. The
 * folder passes uninstall's checks, and the file itself must be that folder's own `references/my-rules.md`, not a link.
 */
async function ownedRulesFile(home: string, workflow: string): Promise<{ readonly shown: string; readonly real: string }> {
  const entry = (await loadWritten(home)).skill_folders.find((folder) => folder.workflow === workflow);
  if (!entry) throw new InputError(`Workflow '${workflow}' has no rules file TaskFollow wrote (its agent has no skills folder TaskFollow knows), so there is nowhere to keep a rule: tell the person, and keep the rule in mind in chat`);
  const shown = join(entry.path, REFERENCES_DIR, RULES_FILE);
  const moved = new InputError(`TaskFollow did not write ${shown} as it is now (moved, linked elsewhere, or without SKILL.md), so it leaves it alone: the person can add the rule there themselves`);
  const [folder, file] = await Promise.all([realpath(entry.path), realpath(shown)]).catch(() => [null, null]);
  const root = await realpath(entry.root).catch(() => entry.root);
  if (!folder || !file || !inside(root, folder) || !(await exists(join(folder, SKILL_FILE))) || file !== join(folder, REFERENCES_DIR, RULES_FILE)) throw moved;
  return { shown, real: file };
}

/**
 * Appends one rule the person said yes to. The first rule replaces the placeholder line: the file is read right
 * before it is written, so what another process added meanwhile is kept; the window left is the few milliseconds of
 * that read and write (as D164). Later rules are appended. Returns the file as recorded.
 */
export async function appendRule(home: string, workflow: string, rule: string): Promise<string> {
  const { shown, real } = await ownedRulesFile(home, workflow);
  const text = await readFile(real, "utf8");
  if (text.includes(NO_RULES_YET)) await writeFile(real, text.replace(NO_RULES_YET, `- ${rule}`));
  else await appendFile(real, `${text === "" || text.endsWith("\n") ? "" : "\n"}- ${rule}\n`);
  return shown;
}

/** Uninstall (9.13 item 5): removes the recorded skill folders and the section, nothing else; what it leaves, it says why. */
export async function removeWritten(home: string): Promise<{ readonly skill_folders: readonly string[]; readonly left: readonly { path: string; why: string }[]; readonly agent_file: string }> {
  const written = await loadWritten(home);
  const removed: string[] = [];
  const left: { path: string; why: string }[] = [];
  for (const entry of written.skill_folders) {
    let real: string;
    try {
      real = await realpath(entry.path);
    } catch {
      continue;
    }
    const root = await realpath(entry.root).catch(() => entry.root);
    if (!inside(root, real) || !(await exists(join(real, SKILL_FILE)))) {
      left.push({ path: entry.path, why: "it is no longer the folder TaskFollow wrote (moved, linked elsewhere, or without SKILL.md)" });
      continue;
    }
    await rm(real, { recursive: true, force: true });
    removed.push(entry.path);
  }
  const notesLeft = written.notes_folder ? await removeNotesFolder(written.notes_folder) : null;
  if (notesLeft !== null && written.notes_folder) left.push({ path: written.notes_folder.path, why: notesLeft });
  const agentFile = written.agent_file ? await removeSection(written.agent_file.path, written.agent_file.created).catch((error: Error) => `left: ${error.message}`) : "absent";
  await rm(join(home, WRITTEN_FILE), { force: true });
  return { skill_folders: removed, left, agent_file: agentFile };
}
