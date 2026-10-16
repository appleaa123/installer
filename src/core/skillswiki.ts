import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { callTool, type McpTarget } from "./mcp.js";
import type { Solution } from "./types.js";

/** The one keychain item and the MCP server name this version knows (D52). */
export const SKILLSWIKI_SECRET_ID = "skillswiki";
export const SKILLSWIKI_MCP_NAME = "skillswiki";
export const KEY_MISSING_HINT = "Skills Wiki key missing: run 'taskfollow secret skillswiki' first";
export const URL_MISSING_HINT = "This install has no Skills Wiki URL: start again with --url <the MCP URL from your Skills Wiki dashboard>";
/** Actions and checks that call Skills Wiki; a solution with any of them needs `start --url`. */
export const SKILLSWIKI_ACTIONS: readonly string[] = ["register_mcp", "probe_mcp"];
export const SKILLSWIKI_CHECKS: readonly string[] = ["combo_active"];
const ALLOWED_URL = /^(https:\/\/|http:\/\/127\.0\.0\.1(:\d+)?\/)/;

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export interface SkillswikiRef {
  readonly pack: string;
  readonly skill: string;
  readonly path: string;
}

/** `skillswiki:<pack>/<skill>/<path>`; the path may contain slashes (spec §6.1). */
export function parseSkillswikiRef(ref: string): SkillswikiRef {
  const match = /^skillswiki:([^/]+)\/([^/]+)\/(.+)$/.exec(ref);
  if (!match || !match[1] || !match[2] || !match[3]) throw new InputError(`Solution reference '${ref}' must be skillswiki:<pack>/<skill>/<path>`);
  return { pack: match[1], skill: match[2], path: match[3] };
}

/** get_skill_resource wraps a file in one `<skill_reference>` (or similar) element; strip exactly that (fact 6). */
export function stripSkillWrapper(content: string): string {
  const match = /^\s*<(skill_[a-z]+)>\n?([\s\S]*?)\n?<\/\1>\s*$/.exec(content);
  return match?.[2] ?? content;
}

export async function fetchSkillswikiSolution(target: McpTarget, ref: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const outcome = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path });
  if (!outcome.ok) throw new ActionFailure(`Skills Wiki could not serve '${ref}': ${outcome.error}`);
  const content = isRecord(outcome.value) ? outcome.value.content : undefined;
  if (typeof content !== "string") throw new ActionFailure(`Skills Wiki returned no content for '${ref}'`);
  return stripSkillWrapper(content);
}

/** The active combo's slug, or null when none is activated (an error answer counts as not activated, D37). */
export async function activeComboSlug(target: McpTarget): Promise<string | null> {
  const outcome = await callTool(target, "get_active_combo");
  if (!outcome.ok || !isRecord(outcome.value)) return null;
  const slug = outcome.value.combo_slug;
  return typeof slug === "string" && slug !== "" && isRecord(outcome.value.combo) ? slug : null;
}

const isWikiRef = (item: unknown): boolean => typeof item === "string" && item.startsWith("skillswiki:");

/** True when any `skill` field, or any entry of a `skills` list (9.12 item 2), inside the raw workflow records names a Skills Wiki skill. */
function namesSkillswikiSkill(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesSkillswikiSkill);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => (key === "skill" && isWikiRef(item)) || (key === "skills" && Array.isArray(item) && item.some(isWikiRef)) || namesSkillswikiSkill(item));
}

/** A solution needs `start --url` when a step calls Skills Wiki or a bundled workflow's judge names one of its skills. */
export function usesSkillswiki(solution: Solution): boolean {
  return (
    solution.steps.some((step) => SKILLSWIKI_ACTIONS.includes(step.auto?.action ?? "") || SKILLSWIKI_CHECKS.includes(step.verify?.check ?? "")) ||
    namesSkillswikiSkill(solution.workflows)
  );
}

/** The key only ever travels over https, or to this machine's own loopback (the test server). */
export function requireSkillswikiUrl(url: string | undefined): string {
  if (!url) throw new InputError("This solution uses Skills Wiki: run start again with --url <the MCP URL from your Skills Wiki dashboard>");
  if (!ALLOWED_URL.test(url)) throw new InputError(`--url must be an https URL, got '${url}'`);
  return url;
}
/** URL from the install state, key from the keychain; both are needed before Skills Wiki is called. */
export async function skillswikiTarget(url: string | undefined, env?: Env): Promise<McpTarget> {
  if (!url) throw new ActionFailure(URL_MISSING_HINT);
  const key = await getSecret(SKILLSWIKI_SECRET_ID, env);
  if (!key) throw new ActionFailure(KEY_MISSING_HINT);
  return { url, key };
}
