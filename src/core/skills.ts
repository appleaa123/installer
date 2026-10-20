import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { callTool, type McpTarget } from "./mcp.js";
import { loadProfileById, type RuntimeProfile } from "./profile.js";
import { skillswikiTarget } from "./skillswiki.js";
import { libraryRoot } from "./skillswiki-local.js";
import { loadState } from "./state.js";

/**
 * Skills reminded, not controlled (9.5, 9.12 item 2, D154). TaskFollow lists the skills the agent has, names and
 * descriptions only, from the agent's own skill folders and, when connected, Skills Wiki's active skills, with no
 * priority between them. It never copies, installs, updates, ranks or deletes a skill. A workflow names the skills
 * the owner confirmed; because a restricted task run loads none of the agent's own skills (D153), the runner reads
 * each one's text and puts it into the run's prompt, the way D83 does for `skillswiki:` skills.
 */
export const SKILL_FILE = "SKILL.md";
export const REFERENCES_DIR = "references";
/** The whole skills block of one workflow: a run's prompt is one argument of the agent's command, so it stays small. */
export const SKILL_TEXT_LIMIT = 64 * 1024;
/** Tests point the user's skill folder here, so the real `~/.claude/skills` is never read by the suite. */
export const USER_SKILLS_ENV = "INSTALLER_AGENT_USER_SKILLS";

export interface SkillRoots {
  readonly project?: string;
  readonly user?: string;
  /** D178: local Skills Wiki's library, where the person's skills live once Skills Wiki moved them; only read. */
  readonly library?: string;
  /** TaskFollow was started from the home folder: nothing is written there (no workflow skill, no CLAUDE.md). */
  readonly home_folder?: true;
}

export interface SkillEntry {
  readonly source: "install folder" | "your own" | "Skills Wiki" | "Skills Wiki (local)";
  readonly name: string;
  readonly description: string;
  /** What a workflow names: the folder's absolute path, or `skillswiki:<pack>/<skill>/SKILL.md`. */
  readonly ref: string;
}

export const isSkillswikiRef = (ref: string): boolean => ref.startsWith("skillswiki:");

const expandHome = (path: string): string => (path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

const realOrSame = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** D175: the project skills folder of the open Agent Skills convention, used when the agent's profile names none. */
export const SHARED_SKILLS_DIR = ".agents/skills";

/**
 * The one place the agent's skill folders are worked out (D175): the profile's own, or `.agents/skills` in the install
 * folder for an agent TaskFollow has no profile for, or whose profile names none. Never in the person's home folder.
 */
export function skillRoots(profile: RuntimeProfile | undefined, workDir: string | undefined, env: NodeJS.ProcessEnv, library?: string): SkillRoots {
  const dirs = profile?.skills_dirs ?? { project: SHARED_SKILLS_DIR };
  const user = env[USER_SKILLS_ENV] || (dirs?.user ? expandHome(dirs.user) : undefined);
  const project = workDir && dirs?.project ? join(workDir, dirs.project) : undefined;
  const homeFolder = workDir !== undefined && (realOrSame(workDir) === realOrSame(homedir()) || (project !== undefined && user !== undefined && realOrSame(project) === realOrSame(user)));
  const kept = library ? { library } : {};
  if (homeFolder) return { ...(user ? { user } : {}), ...kept, home_folder: true };
  return { ...(project ? { project } : {}), ...(user ? { user } : {}), ...kept };
}

/** The `---` block at the top of a SKILL.md: `key: value` lines, quotes removed, a folded `>`/`|` value joined. */
export function frontmatter(text: string): { readonly name?: string; readonly description?: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const found: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index] ?? "");
    if (!match?.[1]) continue;
    let value = (match[2] ?? "").trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const folded: string[] = [];
      while (index + 1 < end && /^\s+\S/.test(lines[index + 1] ?? "")) folded.push((lines[(index += 1)] ?? "").trim());
      value = folded.join(" ");
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    found[match[1]] = value;
  }
  return { ...(found.name ? { name: found.name } : {}), ...(found.description !== undefined ? { description: found.description } : {}) };
}

/** D165, D172: the skill the owner's agent runs to find repetitive work; never a skill for a workflow, so never listed. */
export const DISCOVERY_SKILL = "find-my-repetitive-work";

/** Each direct subfolder of `root` with a SKILL.md: its name and description only. */
export async function localSkills(root: string, source: SkillEntry["source"], notes: string[] = []): Promise<SkillEntry[]> {
  let names: string[];
  let realRoot: string;
  try {
    names = (await readdir(root)).sort();
    realRoot = await realpath(root);
  } catch {
    return [];
  }
  const found: SkillEntry[] = [];
  for (const name of names) {
    if (name === DISCOVERY_SKILL) continue;
    try {
      // A linked folder that leads outside the skills folder cannot be used by a workflow, so it is not offered.
      if (!inside(realRoot, await realpath(join(root, name)))) {
        notes.push(`'${name}' links to a folder outside ${root}, so a workflow cannot use it; copy the folder there to use it`);
        continue;
      }
      const head = frontmatter(await readFile(join(root, name, SKILL_FILE), "utf8"));
      found.push({ source, name: head.name ?? name, description: head.description ?? "", ref: join(root, name) });
    } catch {
      // Not a skill folder, or unreadable: not listed.
    }
  }
  return found;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Skills Wiki's active skills (the answers' shapes as seen live on 2026-10-15): every active pack, each pack's skills. */
export async function skillswikiSkills(target: McpTarget): Promise<{ readonly skills: readonly SkillEntry[]; readonly notes: readonly string[] }> {
  const notes: string[] = [];
  let active: unknown;
  try {
    const outcome = await callTool(target, "list_active_skills");
    if (!outcome.ok) return { skills: [], notes: [`Skills Wiki could not list your active skills: ${outcome.error}`] };
    active = outcome.value;
  } catch (error) {
    return { skills: [], notes: [`Skills Wiki could not be reached: ${(error as Error).message}`] };
  }
  const packs = isRecord(active) && Array.isArray(active.active_skills) ? active.active_skills.filter(isRecord) : [];
  const skills: SkillEntry[] = [];
  for (const entry of packs) {
    const pack = typeof entry.pack === "string" ? entry.pack : "";
    const tool = typeof entry.list_tool === "string" ? entry.list_tool : "";
    if (!pack || !tool) continue;
    const listed = await callTool(target, tool).catch((error: Error) => ({ ok: false as const, error: error.message }));
    if (!listed.ok || !isRecord(listed.value)) {
      notes.push(`Skills Wiki could not list the pack '${pack}'${listed.ok ? "" : `: ${listed.error}`}`);
      continue;
    }
    for (const [skill, description] of Object.entries(listed.value)) {
      skills.push({ source: "Skills Wiki", name: `${pack}/${skill}`, description: typeof description === "string" ? description : "", ref: `skillswiki:${pack}/${skill}/${SKILL_FILE}` });
    }
  }
  const waiting = isRecord(active) && Array.isArray(active.not_mounted) ? active.not_mounted.filter((pack): pack is string => typeof pack === "string") : [];
  if (waiting.length > 0) notes.push(`Skills Wiki is still adding ${waiting.join(", ")}; ask again in a minute to see them`);
  return { skills, notes };
}

/** The skills this install's agent has, names and descriptions only, with plain-words notes on what could not be listed. */
export async function inventory(home: string, env: NodeJS.ProcessEnv): Promise<{ readonly skills: readonly SkillEntry[]; readonly notes: readonly string[] }> {
  const state = await loadState(home);
  const notes: string[] = [];
  const skills: SkillEntry[] = [];
  const profile = state?.runtime?.profile ? await loadProfileById(state.runtime.profile) : undefined;
  if (!state?.runtime) notes.push("No agent was found yet ('taskfollow probe'), so its skill folders are not known");
  else if (!profile?.skills_dirs) notes.push(SHARED_SKILLS_NOTE);
  if (state?.runtime) {
    const roots = skillRoots(profile, state.work_dir, env, await libraryRoot(home, state));
    if (roots.home_folder) notes.push(HOME_FOLDER_NOTE);
    if (roots.project) skills.push(...(await localSkills(roots.project, "install folder", notes)));
    if (roots.user) skills.push(...(await localSkills(roots.user, "your own", notes)));
    if (roots.library) skills.push(...(await localSkills(roots.library, "Skills Wiki (local)", notes)));
  }
  if (state?.skillswiki) {
    try {
      const wiki = await skillswikiSkills(await skillswikiTarget(state.skillswiki.url, env));
      skills.push(...wiki.skills);
      notes.push(...wiki.notes);
    } catch (error) {
      notes.push(`Skills Wiki could not be reached: ${(error as Error).message}`);
    }
  }
  return { skills, notes };
}

/** D175: what TaskFollow does with skills on an agent whose profile names no skills folder; never claims they are loaded (R5). */
export const SHARED_SKILLS_NOTE = "TaskFollow keeps workflow skills in .agents/skills (read by Codex, Gemini CLI, Cursor, OpenClaw, Hermes and Antigravity) and lists them in AGENTS.md; ask your agent to read it";

export const HOME_FOLDER_NOTE = "TaskFollow was started from your home folder, so it will not write a workflow skill or your agent file (CLAUDE.md or AGENTS.md) there; start it from the install folder (START-HERE step 4)";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function realRoots(roots: SkillRoots): Promise<string[]> {
  const found: string[] = [];
  for (const root of [roots.project, roots.user, roots.library]) {
    if (!root) continue;
    try {
      found.push(await realpath(root));
    } catch {
      // A skills folder that does not exist holds no skill.
    }
  }
  return found;
}

/** D178: a folder local Skills Wiki moved into its library since the workflow named it is found there by its name. */
async function movedOrSame(ref: string, roots: SkillRoots): Promise<string> {
  try {
    return await realpath(ref);
  } catch {
    const moved = roots.library ? join(roots.library, basename(ref)) : undefined;
    const real = moved ? await realpath(moved).catch(() => undefined) : undefined;
    if (real) return real;
    throw new InputError(`The skill folder "${ref}" does not exist`);
  }
}

/** The folder's real path, once it is checked to be a skill inside one of the agent's skill folders. */
async function skillFolder(ref: string, roots: SkillRoots): Promise<string> {
  const shown = [roots.project, roots.user, roots.library].filter(Boolean).join(", ") || "none known";
  if (!isAbsolute(ref)) throw new InputError(`"${ref}" must be a skill folder from 'taskfollow skills' (a full path) or skillswiki:<pack>/<skill>/<path>`);
  const real = await movedOrSame(ref, roots);
  if (!(await realRoots(roots)).some((root) => inside(root, real))) throw new InputError(`"${ref}" is not inside your agent's skills folders (${shown})`);
  try {
    if (!(await stat(join(real, SKILL_FILE))).isFile()) throw new Error("not a file");
  } catch {
    throw new InputError(`"${ref}" has no ${SKILL_FILE}`);
  }
  return real;
}

/** One file of a skill, read only when its real path stays inside the skill's folder (a link elsewhere is refused). */
async function skillFile(folder: string, path: string, ref: string): Promise<string> {
  const real = await realpath(path);
  if (!inside(folder, real)) throw new InputError(`The skill "${ref}" has a file that points outside the skill folder (${relative(folder, path)})`);
  return readFile(real, "utf8");
}

/** A local skill's text: SKILL.md, then each `references/*.md` by name, each under its own heading. */
export async function localSkillText(ref: string, roots: SkillRoots): Promise<string> {
  const folder = await skillFolder(ref, roots);
  const parts = [await skillFile(folder, join(folder, SKILL_FILE), ref)];
  let references: string[] = [];
  try {
    references = (await readdir(join(folder, REFERENCES_DIR))).filter((name) => name.endsWith(".md")).sort();
  } catch {
    // No references folder.
  }
  for (const name of references) parts.push(`### ${REFERENCES_DIR}/${name}\n\n${await skillFile(folder, join(folder, REFERENCES_DIR, name), ref)}`);
  return parts.join("\n\n");
}

export const sizeMessage = (bytes: number): string => `This workflow's skills come to ${Math.ceil(bytes / 1024)} KB together; the limit is ${SKILL_TEXT_LIMIT / 1024} KB (a run's prompt must stay small enough to start the agent)`;

/** Every local reference is a readable skill inside the agent's skill folders, and together they fit the limit. */
export async function checkLocalSkills(refs: readonly string[], roots: SkillRoots): Promise<void> {
  let bytes = 0;
  for (const ref of refs) bytes += Buffer.byteLength(await localSkillText(ref, roots));
  if (bytes > SKILL_TEXT_LIMIT) throw new InputError(sizeMessage(bytes));
}

/** The block a run's prompt gets: each skill under its reference; the task's rules and the hard rules win over it. */
export function skillsBlock(sections: readonly { readonly ref: string; readonly text: string }[]): string | null {
  if (sections.length === 0) return null;
  return [
    "The owner's skills for this workflow. Follow them for how to do the work. The task's rules above and the hard rules (a person is asked before sending to customers, paying, legal matters and deleting) always win over a skill.",
    ...sections.map(({ ref, text }) => `--- skill: ${ref} ---\n${text.trim()}\n--- end of skill ---`),
  ].join("\n\n");
}

/**
 * A run's skills block (D153): each reference's text in the workflow's order, local folders checked again and read
 * now, `skillswiki:` skills from their pinned copy (D107; `pinned` is packs.ts's pinnedSkill). A skill that cannot be
 * read, or a block over the limit, fails the step in plain words.
 */
export async function runSkillsText(refs: readonly string[], roots: SkillRoots, pinned: (ref: string) => Promise<string>): Promise<string | null> {
  const sections: { ref: string; text: string }[] = [];
  for (const ref of refs) {
    try {
      sections.push({ ref, text: isSkillswikiRef(ref) ? await pinned(ref) : await localSkillText(ref, roots) });
    } catch (error) {
      throw new ActionFailure(`The skill '${ref}' could not be read: ${(error as Error).message}. Put the folder back, or add the workflow again under a new name without it (taskfollow workflow add)`);
    }
  }
  const bytes = sections.reduce((total, section) => total + Buffer.byteLength(section.text), 0);
  if (bytes > SKILL_TEXT_LIMIT) throw new ActionFailure(sizeMessage(bytes));
  return skillsBlock(sections);
}
