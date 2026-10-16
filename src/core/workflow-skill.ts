import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readSection, removeSection, sectionText, writeSection, type WorkflowLine } from "./agent-file.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { loadProfileById, type RuntimeProfile } from "./profile.js";
import { REFERENCES_DIR, SKILL_FILE, skillRoots, type SkillRoots } from "./skills.js";
import { loadState } from "./state.js";
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

export function rulesMarkdown(id: string, rules: string | undefined): string {
  const body = rules?.trim() || "None yet. When the owner corrects a result, the agent proposes a rule here and adds it only after the owner says yes.";
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
  const agentFile = written.agent_file ? await removeSection(written.agent_file.path, written.agent_file.created).catch((error: Error) => `left: ${error.message}`) : "absent";
  await rm(join(home, WRITTEN_FILE), { force: true });
  return { skill_folders: removed, left, agent_file: agentFile };
}
