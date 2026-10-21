import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { runProcessWithStderr, type ProcessResult } from "./headless.js";
import type { InstallState } from "./types.js";

/**
 * Local Skills Wiki (the open-source one, D178): an optional add-on the person chooses with the `services.skills`
 * question. TaskFollow installs a pinned version with pipx and runs its setup from the person's home folder, which
 * moves their installed skills into its library (they agreed to that in the question); Skills Wiki then wires itself
 * into the person's agents (its own MCP server, hook and rules). TaskFollow only reads the library's skill folders.
 */
export const LOCAL_SKILLS_QUESTION = "services.skills";
export const LOCAL_SKILLS_OPTION = "skills";
export const SKILLSWIKI_VERSION = "0.3.3";
export const SKILLSWIKI_SOURCE = `git+https://github.com/appleaa123/skills_wiki_opensource.git@v${SKILLSWIKI_VERSION}`;
export const LOCAL_FILE = join("state", "skillswiki-local.json");
/** Test runs set it to `none`, so no test ever runs the real pipx or moves real skills. */
export const INSTALL_ENV = "INSTALLER_SKILLSWIKI_INSTALL";
/** D178: `taskfollow add skills` says this and does nothing until the person agreed (`--confirm-move`). */
export const MOVE_WARNING = "Setting up local Skills Wiki moves the person's installed skills into the Skills Wiki library (~/.skillswiki); their agents then reach them through Skills Wiki, and 'skillswiki release --all' puts them back. Tell the person this and ask whether to go ahead; only when they say yes, run 'taskfollow add skills --confirm-move'";
/** Newest first; `python3` last, since it may be older than Skills Wiki needs. */
const PYTHONS = ["python3.13", "python3.12", "python3.11", "python3"];
const MIN_PYTHON = [3, 11] as const;
const CHECK_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const SETUP_TIMEOUT_MS = 5 * 60_000;
const PREREQ_HINT = "Local Skills Wiki needs Python 3.11 or newer and pipx (https://pipx.pypa.io). Install them, then run 'taskfollow resume'";
const PATH_HINT = "Skills Wiki is installed, but its 'skillswiki' command is not on your PATH, so your agents could not reach it. Run 'pipx ensurepath', open a new terminal, then run 'taskfollow resume'. Nothing was moved yet";

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** What TaskFollow keeps about the local install, so the tick and the doctor do not depend on their own PATH. */
export interface LocalSkillswiki {
  readonly version: string;
  readonly bin: string;
  readonly library: string;
}

/** True when the person chose local Skills Wiki for this install. */
export const localSkillsOn = (state: InstallState | undefined): boolean => state?.steps[LOCAL_SKILLS_QUESTION]?.value === LOCAL_SKILLS_OPTION;

export async function readLocalSkillswiki(home: string): Promise<LocalSkillswiki | null> {
  const value = await readConfig(home, LOCAL_FILE);
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.bin !== "string" || typeof value.library !== "string") return null;
  return { version: value.version, bin: value.bin, library: value.library };
}

/** The Skills Wiki library TaskFollow reads skills from: only when local Skills Wiki is on and was installed. */
export async function libraryRoot(home: string, state: InstallState | undefined): Promise<string | undefined> {
  return localSkillsOn(state) ? (await readLocalSkillswiki(home))?.library : undefined;
}

/** The first PATH folder holding an executable `name` (`.exe` too on Windows), from the env given. */
export async function onPath(name: string, env: Env): Promise<string | null> {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  for (const folder of (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => entry !== "")) {
    for (const candidate of names) {
      const path = join(folder, candidate);
      if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
    }
  }
  return null;
}

const run = (argv: readonly string[], cwd: string, timeoutMs: number, env: Env): Promise<ProcessResult> => runProcessWithStderr(argv, cwd, timeoutMs, { ...env } as NodeJS.ProcessEnv);

/** The reason a command failed, in its own words when it printed any (Skills Wiki prints a JSON error). */
function why(result: ProcessResult): string {
  const said = result.stderr?.trim() ?? "";
  try {
    const parsed = JSON.parse(said) as unknown;
    if (isRecord(parsed) && typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON: use the text as printed
  }
  return said.split("\n").slice(-3).join(" ").trim() || result.error || "no reason given";
}

async function newEnoughPython(env: Env, cwd: string): Promise<string | null> {
  for (const name of PYTHONS) {
    const path = await onPath(name, env);
    if (!path) continue;
    const result = await run([path, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], cwd, CHECK_TIMEOUT_MS, env);
    const [major = 0, minor = 0] = result.stdout.trim().split(".").map(Number);
    if (major > MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1])) return path;
  }
  return null;
}

/** `skillswiki --json doctor`: its version, library folder and each wired agent's MCP state, or null when it does not answer. */
export async function askDoctor(bin: string, env: Env, cwd: string = env.HOME ?? homedir()): Promise<{ version: string; library: string; mcp: Readonly<Record<string, string>> } | null> {
  const result = await run([bin, "--json", "doctor"], cwd, CHECK_TIMEOUT_MS, env);
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const library = isRecord(parsed) && isRecord(parsed.library) ? parsed.library.path : undefined;
    const rows = isRecord(parsed) && Array.isArray(parsed.wiring) ? parsed.wiring.filter(isRecord) : [];
    const mcp = Object.fromEntries(rows.flatMap((row) => (typeof row.agent === "string" && typeof row.mcp === "string" ? [[row.agent, row.mcp]] : [])));
    return isRecord(parsed) && typeof parsed.version === "string" && typeof library === "string" ? { version: parsed.version, library, mcp } : null;
  } catch {
    return null;
  }
}

/** D178: Skills Wiki names an agent like TaskFollow's profile, with `_` for `-` (`claude-code` → `claude_code`). */
export const wiringKey = (profile: string): string => profile.replace(/-/g, "_");
/** MCP states in which the agent cannot reach Skills Wiki's server until the person does something. */
export const UNWIRED_STATES: readonly string[] = ["none", "self_setup"];

/** Installs (or upgrades to) the pinned version with pipx, unless that version already answers. */
async function ensureInstalled(env: Env, cwd: string): Promise<string> {
  const found = await onPath("skillswiki", env);
  const current = found ? await askDoctor(found, env, cwd) : null;
  if (found && current?.version === SKILLSWIKI_VERSION) return found;
  const [python, pipx] = [await newEnoughPython(env, cwd), await onPath("pipx", env)];
  if (!python || !pipx) throw new ActionFailure(PREREQ_HINT);
  const installed = await run([pipx, "install", ...(current ? ["--force"] : []), "--python", python, SKILLSWIKI_SOURCE], cwd, INSTALL_TIMEOUT_MS, env);
  if (installed.code !== 0) throw new ActionFailure(`pipx could not install Skills Wiki: ${why(installed)}`);
  const bin = await onPath("skillswiki", env);
  if (!bin) throw new ActionFailure(PATH_HINT);
  return bin;
}

/** `skillswiki --json setup` always exits 0; a stop or a skill that could not move is in its answer. */
async function setup(bin: string, cwd: string, env: Env): Promise<{ moved: number; backup: string | null }> {
  const result = await run([bin, "--json", "setup"], cwd, SETUP_TIMEOUT_MS, env);
  if (result.code !== 0) throw new ActionFailure(`Skills Wiki setup failed: ${why(result)}`);
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new ActionFailure("Skills Wiki setup gave no answer TaskFollow can read; run 'skillswiki setup' yourself to see what happened");
  }
  if (!isRecord(answer) || answer.stopped !== false || !isRecord(answer.moved)) throw new ActionFailure("Skills Wiki setup stopped before it finished; run 'skillswiki setup' yourself to see why");
  const failed = Array.isArray(answer.moved.failed) ? answer.moved.failed : [];
  if (failed.length > 0) {
    const slugs = failed.map((entry) => (isRecord(entry) && typeof entry.slug === "string" ? entry.slug : "?")).join(", ");
    throw new ActionFailure(`Skills Wiki could not move these skills: ${slugs}. Run 'skillswiki setup' yourself to see why, then 'taskfollow resume'`);
  }
  const moved = Array.isArray(answer.moved.adopted) ? answer.moved.adopted.length : 0;
  return { moved, backup: typeof answer.backup === "string" ? answer.backup : null };
}

/**
 * The `install_skillswiki` action (D178). Setup runs from the person's home folder, never the install folder, so the
 * workflow skills TaskFollow wrote there stay where it wrote them. Nothing moves before `skillswiki` is on the PATH,
 * because the agents start it by that name.
 */
export async function installLocalSkillswiki(home: string, env: Env = process.env): Promise<{ readonly local: LocalSkillswiki; readonly moved: number; readonly backup: string | null }> {
  if (env[INSTALL_ENV] === "none") throw new ActionFailure("Local Skills Wiki is not installed in this run (INSTALLER_SKILLSWIKI_INSTALL=none)");
  const cwd = env.HOME ?? homedir();
  const bin = await ensureInstalled(env, cwd);
  const { moved, backup } = await setup(bin, cwd, env);
  const checked = await askDoctor(bin, env, cwd);
  if (!checked) throw new ActionFailure("Skills Wiki was set up but does not answer 'skillswiki doctor'; run it yourself to see why, then 'taskfollow resume'");
  const local: LocalSkillswiki = { version: checked.version, bin, library: checked.library };
  await writeConfig(home, LOCAL_FILE, local);
  return { local, moved, backup };
}

/**
 * `taskfollow uninstall --remove-skillswiki` (D178): Skills Wiki puts every skill back and disconnects the agents
 * first; only when nothing was left behind is the program itself removed with pipx.
 */
export async function removeLocalSkillswiki(home: string, env: Env = process.env): Promise<{ readonly status: "removed" | "not_installed" | "kept"; readonly detail?: string; readonly left?: readonly string[] }> {
  const local = await readLocalSkillswiki(home);
  if (!local) return { status: "not_installed" };
  const cwd = env.HOME ?? homedir();
  const released = await run([local.bin, "--json", "uninstall", "--yes"], cwd, SETUP_TIMEOUT_MS, env);
  let answer: unknown;
  try {
    answer = JSON.parse(released.stdout);
  } catch {
    answer = null;
  }
  if (released.code !== 0 || !isRecord(answer) || answer.blocked !== false || answer.stopped !== false) {
    return { status: "kept", detail: `Skills Wiki could not put every skill back (${why(released)}), so it was not removed; run 'skillswiki uninstall' in a terminal to see what is left` };
  }
  const pipx = await onPath("pipx", env);
  const removed = pipx ? await run([pipx, "uninstall", "skillswiki"], cwd, INSTALL_TIMEOUT_MS, env) : null;
  const left = leftForPerson(answer.disconnected);
  if (!removed || removed.code !== 0) return { status: "kept", detail: `Your skills are back, but the program is still installed (${removed ? why(removed) : "pipx not found"}); remove it with 'pipx uninstall skillswiki'`, ...(left.length > 0 ? { left } : {}) };
  return { status: "removed", ...(left.length > 0 ? { left } : {}) };
}

/** What Skills Wiki could not undo in an agent itself (its CLI was not on the PATH, say): the line it asks the person to run. */
function leftForPerson(disconnected: unknown): string[] {
  const parts = Array.isArray(disconnected) ? disconnected.filter(isRecord).flatMap((agent) => [agent.method, agent.mcp]) : [];
  return parts.flatMap((part) => (isRecord(part) && typeof part.prompt === "string" && part.prompt !== "" ? [part.prompt] : []));
}
