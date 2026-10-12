import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { InputError } from "./inputs.js";

/** Approval levels (spec §11.2): L0 read, L1 internal, L2 human approval, L3 floor. */
export const LEVELS = ["L0", "L1", "L2", "L3"] as const;
export type Level = (typeof LEVELS)[number];

/** Spec §11.3, compiled into the engine (D24): client rules may add to it, never remove from it. */
export const FLOOR_CATEGORIES = ["legal_notice", "money", "contract", "irreversible", "personal_data_export", "policy_change", "protected_ground"] as const;
export type FloorCategory = (typeof FLOOR_CATEGORIES)[number];

/** Field tags (spec §9.3), assigned by the data contract (src/core/contract.ts). */
export const FIELD_TAGS = ["financial", "protected_ground", "personal"] as const;
export type FieldTag = (typeof FIELD_TAGS)[number];
export const FLOOR_TAGS: readonly FieldTag[] = ["financial", "protected_ground"];

/** A tool that declares no level is an ordinary write (§11.4). */
export const DEFAULT_LEVEL: Level = "L2";

export const ROLES = ["member", "decision_maker"] as const;
export type Role = (typeof ROLES)[number];

export interface FieldRef {
  readonly entity: string;
  readonly field: string;
}

/** Where field tags come from: the pinned data contract (`contractTags`); NO_TAGS when the install has none. */
export type TagSource = (field: FieldRef) => readonly FieldTag[];
export const NO_TAGS: TagSource = () => [];

/** Tool name → level from `config/approval-rules.json`; a rule can only raise a level (D24). */
export type ClientRules = Readonly<Record<string, Level>>;

/** What the engine knows about one call: declared tool metadata and the fields it writes, never model output. */
export interface LevelFacts {
  readonly tool: string;
  readonly level?: Level;
  readonly categories: readonly FloorCategory[];
  readonly writes: readonly FieldRef[];
}

export interface Derived {
  readonly level: Level;
  readonly reasons: readonly string[];
}

export const levelRank = (level: Level): number => LEVELS.indexOf(level);

/** Needs an approval token before it runs (§11.1). */
export const needsApproval = (level: Level): boolean => levelRank(level) >= levelRank("L2");

/** level = max(declared, field tags written, floor category, client rule) — spec §11.4. */
export function deriveLevel(facts: LevelFacts, tags: TagSource, rules: ClientRules): Derived {
  const candidates: { level: Level; reason: string }[] = [{ level: facts.level ?? DEFAULT_LEVEL, reason: facts.level ? `declared ${facts.level}` : `no declared level (default ${DEFAULT_LEVEL})` }];
  for (const category of facts.categories) candidates.push({ level: "L3", reason: `floor: ${category}` });
  for (const field of facts.writes) {
    for (const tag of tags(field).filter((item) => FLOOR_TAGS.includes(item))) candidates.push({ level: "L3", reason: `writes ${field.entity}.${field.field} (${tag})` });
  }
  const rule = Object.hasOwn(rules, facts.tool) ? rules[facts.tool] : undefined;
  if (rule) candidates.push({ level: rule, reason: `client rule ${rule}` });
  const level = candidates.reduce<Level>((top, item) => (levelRank(item.level) > levelRank(top) ? item.level : top), "L0");
  return { level, reasons: candidates.filter((item) => item.level === level).map((item) => item.reason) };
}

/** Default role requirements (§11.9): L2 any member, L3 the decision maker; L0–L1 need nobody. */
export function requiredRole(level: Level): Role | null {
  if (level === "L3") return "decision_maker";
  return level === "L2" ? "member" : null;
}

export const roleAtLeast = (actual: Role, required: Role): boolean => ROLES.indexOf(actual) >= ROLES.indexOf(required);

export const RULES_FILE = join("config", "approval-rules.json");

function parseRules(text: string): ClientRules {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InputError(`${RULES_FILE} is not valid JSON`);
  }
  const tools = (json as { tools?: unknown } | null)?.tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) throw new InputError(`${RULES_FILE} must be {"tools": {"<tool>": "L0" | "L1" | "L2" | "L3"}}`);
  for (const [tool, level] of Object.entries(tools)) {
    if (!(LEVELS as readonly unknown[]).includes(level)) throw new InputError(`${RULES_FILE}: '${tool}' must be one of ${LEVELS.join(", ")}`);
  }
  return tools as ClientRules;
}

/** The client's own rules (optional file). A missing file means no rules. */
export async function loadClientRules(home: string): Promise<ClientRules> {
  let text: string;
  try {
    text = await readFile(await confinedPath(home, RULES_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  return parseRules(text);
}
