import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface RuntimeProfile {
  readonly id: string;
  readonly name: string;
  readonly min_version: string;
  readonly detect: { readonly cmd: readonly string[]; readonly match: string };
  readonly headless: {
    readonly cmd: readonly string[];
    readonly result_path: string;
    readonly session_path: string;
    readonly error_path?: string;
    /** Appended to every headless call except the C6 probe, which uses allow_tool instead (D52, D54). */
    readonly tools_off?: readonly string[];
    readonly allow_tool?: readonly string[];
    /** `jsonl`: one JSON event per line (Codex `exec --json`); the paths are read line by line. Default `json`. */
    readonly output?: "json" | "jsonl";
    /** JSON Lines only: the answer is in the last line whose `path` equals `equals` (for example an agent message). */
    readonly result_line?: { readonly path: string; readonly equals: string };
  };
  /** `{schema_json}` passes the schema inline; `{schema_file}` names a file the engine writes for the call. */
  readonly schema?: { readonly flag: readonly string[]; readonly result_path: string };
  /** `flag` is appended to the headless command; `cmd` replaces it when a session is resumed (Codex `exec resume`). */
  readonly resume?: { readonly flag: readonly string[] } | { readonly cmd: readonly string[] };
  /** Run by the engine, never by the agent, to add or remove an MCP server (D46, D52). */
  readonly mcp_register?: { readonly cmd: readonly string[] };
  readonly mcp_remove?: { readonly cmd: readonly string[] };
  /** A task step's command (D139): the agent with its own tools, limited to `{may_use}`, under the hook in `{settings_json}`. */
  readonly task?: { readonly cmd: readonly string[] };
  /** The person's own settings TaskFollow knows how to edit for watching and always-ask (D146, D147); none for other agents. */
  readonly personal_settings?: "claude";
  readonly tos_review: { readonly status: "ok" | "pending" | "blocked"; readonly note: string };
  /** Folder the profile file was loaded from; fills {profile_dir} in commands. */
  readonly dir: string;
}

/** Bundled profiles ship in the package next to dist/ (src/core → ../../profiles, dist/core → ../../profiles). */
export const PROFILES_DIR = fileURLToPath(new URL("../../profiles/", import.meta.url));
const ID_PATTERN = /^[a-z0-9-]+$/;
const TOS_STATUSES = ["ok", "pending", "blocked"] as const;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") throw new ProfileError(`Profile ${where} must be a non-empty string`);
  return value;
}

/** Placeholders each command may use; anything else is an authoring error caught at load time, never at run time. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "detect.cmd": ["profile_dir"],
  "headless.cmd": ["profile_dir", "prompt"],
  "headless.tools_off": [],
  "headless.allow_tool": ["tool"],
  "schema.flag": ["schema_json", "schema_file"],
  "resume.flag": ["session_id"],
  "resume.cmd": ["profile_dir", "prompt", "session_id"],
  "mcp_register.cmd": ["profile_dir", "name", "config_json"],
  "mcp_remove.cmd": ["profile_dir", "name"],
  "task.cmd": ["profile_dir", "prompt", "may_use", "tools", "settings_json", "mcp_config"],
};

function argv(value: unknown, where: string, ...placeholders: string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) {
    throw new ProfileError(`Profile ${where} must be a non-empty list of strings`);
  }
  for (const placeholder of placeholders) {
    if (!value.some((part: string) => part.includes(placeholder))) throw new ProfileError(`Profile ${where} must contain ${placeholder}`);
  }
  const unknown = (value as string[]).flatMap((part) => [...part.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1])).find((name) => !(ALLOWED[where] ?? []).includes(name));
  if (unknown) throw new ProfileError(`Profile ${where} uses {${unknown}}, which it cannot use`);
  return value as string[];
}

function obj(value: unknown, where: string): Raw {
  if (!isRecord(value)) throw new ProfileError(`Profile ${where} must be an object`);
  return value;
}

function outputParts(headless: Raw): Pick<RuntimeProfile["headless"], "output" | "result_line"> {
  if (headless.output !== undefined && headless.output !== "json" && headless.output !== "jsonl") throw new ProfileError("Profile headless.output must be json or jsonl");
  const line = headless.result_line === undefined ? undefined : obj(headless.result_line, "headless.result_line");
  return {
    ...(headless.output === undefined ? {} : { output: headless.output }),
    ...(line ? { result_line: { path: str(line.path, "headless.result_line.path"), equals: str(line.equals, "headless.result_line.equals") } } : {}),
  };
}

function headlessPart(raw: Raw): RuntimeProfile["headless"] {
  const headless = obj(raw.headless, "headless");
  return {
    cmd: argv(headless.cmd, "headless.cmd", "{prompt}"),
    result_path: str(headless.result_path, "headless.result_path"),
    session_path: str(headless.session_path, "headless.session_path"),
    ...(headless.error_path === undefined ? {} : { error_path: str(headless.error_path, "headless.error_path") }),
    ...(headless.tools_off === undefined ? {} : { tools_off: argv(headless.tools_off, "headless.tools_off") }),
    ...(headless.allow_tool === undefined ? {} : { allow_tool: argv(headless.allow_tool, "headless.allow_tool", "{tool}") }),
    ...outputParts(headless),
  };
}

function mcpParts(raw: Raw): Pick<RuntimeProfile, "mcp_register" | "mcp_remove"> {
  const register = raw.mcp_register === undefined ? undefined : obj(raw.mcp_register, "mcp_register");
  const remove = raw.mcp_remove === undefined ? undefined : obj(raw.mcp_remove, "mcp_remove");
  return {
    ...(register ? { mcp_register: { cmd: argv(register.cmd, "mcp_register.cmd", "{name}", "{config_json}") } } : {}),
    ...(remove ? { mcp_remove: { cmd: argv(remove.cmd, "mcp_remove.cmd", "{name}") } } : {}),
  };
}
function schemaFlag(value: unknown): readonly string[] {
  const flag = argv(value, "schema.flag");
  if (!flag.some((part) => part.includes("{schema_json}") || part.includes("{schema_file}"))) throw new ProfileError("Profile schema.flag must contain {schema_json} or {schema_file}");
  return flag;
}

function resumePart(resume: Raw): NonNullable<RuntimeProfile["resume"]> {
  if ((resume.flag === undefined) === (resume.cmd === undefined)) throw new ProfileError("Profile resume has either a flag or a cmd");
  return resume.cmd === undefined ? { flag: argv(resume.flag, "resume.flag", "{session_id}") } : { cmd: argv(resume.cmd, "resume.cmd", "{session_id}", "{prompt}") };
}

function optionalParts(raw: Raw): Pick<RuntimeProfile, "schema" | "resume"> {
  const schema = raw.schema === undefined ? undefined : obj(raw.schema, "schema");
  const resume = raw.resume === undefined ? undefined : obj(raw.resume, "resume");
  return {
    ...(schema ? { schema: { flag: schemaFlag(schema.flag), result_path: str(schema.result_path, "schema.result_path") } } : {}),
    ...(resume ? { resume: resumePart(resume) } : {}),
  };
}

function personalPart(raw: Raw): Pick<RuntimeProfile, "personal_settings"> {
  if (raw.personal_settings === undefined) return {};
  if (raw.personal_settings !== "claude") throw new ProfileError("Profile personal_settings must be claude");
  return { personal_settings: "claude" };
}

export function parseProfile(value: unknown, dir: string): RuntimeProfile {
  const raw = obj(value, "file");
  const id = str(raw.id, "id");
  if (!ID_PATTERN.test(id)) throw new ProfileError(`Profile id must be lowercase letters, digits and dashes, got '${id}'`);
  const detect = obj(raw.detect, "detect");
  const tos = obj(raw.tos_review, "tos_review");
  if (!(TOS_STATUSES as readonly unknown[]).includes(tos.status)) throw new ProfileError(`Profile tos_review.status must be one of ${TOS_STATUSES.join(", ")}`);
  return {
    id,
    name: str(raw.name, "name"),
    min_version: str(raw.min_version, "min_version"),
    detect: { cmd: argv(detect.cmd, "detect.cmd"), match: str(detect.match, "detect.match") },
    headless: headlessPart(raw),
    ...optionalParts(raw),
    ...mcpParts(raw),
    ...(raw.task === undefined ? {} : { task: { cmd: argv(obj(raw.task, "task").cmd, "task.cmd", "{prompt}", "{may_use}", "{settings_json}") } }),
    ...personalPart(raw),
    tos_review: { status: tos.status as RuntimeProfile["tos_review"]["status"], note: str(tos.note, "tos_review.note") },
    dir,
  };
}

/** `ref` is a bundled profile id, or a path to a profile file (contains '/' or ends in .json). */
export async function loadProfile(ref: string): Promise<RuntimeProfile> {
  const isPath = ref.includes("/") || ref.endsWith(".json");
  if (!isPath && !ID_PATTERN.test(ref)) throw new ProfileError(`Unknown runtime profile '${ref}'`);
  const path = isPath ? resolve(ref) : join(PROFILES_DIR, `${ref}.json`);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ProfileError(`Unknown runtime profile '${ref}'`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProfileError(`Runtime profile '${ref}' is not valid JSON`);
  }
  return parseProfile(json, dirname(path));
}

export const PROFILE_DIR_ENV = "INSTALLER_PROFILE_DIR";

/**
 * Solutions name a profile by id only (D34): a path would let a solution make the engine run any command.
 * The operator may add a folder of extra profiles with INSTALLER_PROFILE_DIR; it is searched before the bundled ones.
 */
export async function loadProfileById(id: string): Promise<RuntimeProfile> {
  if (!ID_PATTERN.test(id)) throw new ProfileError(`Runtime profile '${id}' must be a runtime profile id, not a path`);
  const extra = process.env[PROFILE_DIR_ENV];
  if (extra) {
    const path = join(resolve(extra), `${id}.json`);
    try {
      await readFile(path);
      return await loadProfile(path);
    } catch (error) {
      if (error instanceof ProfileError) throw error;
    }
  }
  return loadProfile(id);
}

/**
 * The bundled profiles the engine may pick by itself (the probe without a named profile, disconnect): only those
 * whose vendor terms were reviewed (D32). A profile still under review (Codex, O2) is used only when named.
 */
export async function listBundledProfiles(): Promise<RuntimeProfile[]> {
  const names = (await readdir(PROFILES_DIR)).filter((name) => name.endsWith(".json")).sort();
  const profiles = await Promise.all(names.map((name) => loadProfile(join(PROFILES_DIR, name))));
  return profiles.filter((profile) => profile.tos_review.status === "ok");
}

export function versionAtLeast(actual: string, min: string): boolean {
  const parts = (version: string): number[] => version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [a, m] = [parts(actual), parts(min)];
  for (let index = 0; index < Math.max(a.length, m.length); index += 1) {
    const diff = (a[index] ?? 0) - (m[index] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}
