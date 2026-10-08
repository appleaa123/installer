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
  readonly headless: { readonly cmd: readonly string[]; readonly result_path: string; readonly session_path: string; readonly error_path?: string };
  readonly schema?: { readonly flag: readonly string[]; readonly result_path: string };
  readonly resume?: { readonly flag: readonly string[] };
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
  "schema.flag": ["schema_json"],
  "resume.flag": ["session_id"],
};

function argv(value: unknown, where: string, placeholder?: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string")) {
    throw new ProfileError(`Profile ${where} must be a non-empty list of strings`);
  }
  if (placeholder && !value.some((part: string) => part.includes(placeholder))) throw new ProfileError(`Profile ${where} must contain ${placeholder}`);
  const unknown = (value as string[]).flatMap((part) => [...part.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1])).find((name) => !(ALLOWED[where] ?? []).includes(name));
  if (unknown) throw new ProfileError(`Profile ${where} uses {${unknown}}, which it cannot use`);
  return value as string[];
}

function obj(value: unknown, where: string): Raw {
  if (!isRecord(value)) throw new ProfileError(`Profile ${where} must be an object`);
  return value;
}

function optionalParts(raw: Raw): Pick<RuntimeProfile, "schema" | "resume"> {
  const schema = raw.schema === undefined ? undefined : obj(raw.schema, "schema");
  const resume = raw.resume === undefined ? undefined : obj(raw.resume, "resume");
  return {
    ...(schema ? { schema: { flag: argv(schema.flag, "schema.flag", "{schema_json}"), result_path: str(schema.result_path, "schema.result_path") } } : {}),
    ...(resume ? { resume: { flag: argv(resume.flag, "resume.flag", "{session_id}") } } : {}),
  };
}

export function parseProfile(value: unknown, dir: string): RuntimeProfile {
  const raw = obj(value, "file");
  const id = str(raw.id, "id");
  if (!ID_PATTERN.test(id)) throw new ProfileError(`Profile id must be lowercase letters, digits and dashes, got '${id}'`);
  const detect = obj(raw.detect, "detect");
  const headless = obj(raw.headless, "headless");
  const tos = obj(raw.tos_review, "tos_review");
  if (!(TOS_STATUSES as readonly unknown[]).includes(tos.status)) throw new ProfileError(`Profile tos_review.status must be one of ${TOS_STATUSES.join(", ")}`);
  return {
    id,
    name: str(raw.name, "name"),
    min_version: str(raw.min_version, "min_version"),
    detect: { cmd: argv(detect.cmd, "detect.cmd"), match: str(detect.match, "detect.match") },
    headless: {
      cmd: argv(headless.cmd, "headless.cmd", "{prompt}"),
      result_path: str(headless.result_path, "headless.result_path"),
      session_path: str(headless.session_path, "headless.session_path"),
      ...(headless.error_path === undefined ? {} : { error_path: str(headless.error_path, "headless.error_path") }),
    },
    ...optionalParts(raw),
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

export async function listBundledProfiles(): Promise<RuntimeProfile[]> {
  const names = (await readdir(PROFILES_DIR)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map((name) => loadProfile(join(PROFILES_DIR, name))));
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
