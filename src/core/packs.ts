import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit, canonicalJson } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { fetchSkillswikiSolution, parseSkillswikiRef, skillswikiTarget } from "./skillswiki.js";
import { StateCorruptError } from "./state.js";

/**
 * Pack pinning (spec §14.3, D34, D107). Skills Wiki serves the newest text of a skill file, and none of its MCP answers
 * says which version that is (`skill_pack_meta.commit_sha` is not served). So the engine pins by content: the first
 * time a judge needs a file of a pack, the engine fetches it, keeps the text under `packs/<pack>/<sha256>` and records
 * the sha256 in `config/packs.json`; from then on judges read the pinned copy, whatever Skills Wiki serves. A pack's
 * version is the sha256 of its files' sha256s. `checkPacks` (run by `installer packs check` and the daily doctor)
 * fetches every pinned file again: different text is a candidate version, kept beside the pinned one and read only
 * by shadow runs (D108) until the decision maker switches. A pinned copy that changed on disk is never used.
 */
export const PACKS_FILE = join("config", "packs.json");
export const PACK_STORE = "packs";

/** `<skill>/<path>` → sha256 of the file's text. */
export type PackFiles = Readonly<Record<string, string>>;

export interface Candidate {
  readonly version: string;
  readonly files: PackFiles;
  readonly found_at: string;
}

export interface PackPin {
  readonly version: string;
  readonly files: PackFiles;
  readonly pinned_at: string;
  readonly candidate?: Candidate;
}

export type Packs = Readonly<Record<string, PackPin>>;

export interface PackUpdate {
  readonly pack: string;
  readonly from: string;
  readonly to: string;
  readonly changed: readonly string[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const packVersion = (files: PackFiles): string => sha256(canonicalJson(files));

export async function loadPacks(home: string): Promise<Packs> {
  const raw = await readConfig(home, PACKS_FILE);
  if (raw === null) return {};
  if (!isRecord(raw) || !Object.values(raw).every((pin) => isRecord(pin) && typeof pin.version === "string" && isRecord(pin.files))) throw new StateCorruptError(`${PACKS_FILE} has an unexpected shape; restore it from a copy`);
  return raw as unknown as Packs;
}

export const savePacks = (home: string, packs: Packs): Promise<void> => writeConfig(home, PACKS_FILE, packs);

async function storeText(home: string, pack: string, text: string): Promise<string> {
  const sha = sha256(text);
  const path = await confinedPath(home, join(PACK_STORE, pack, sha));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return sha;
}

async function storedText(home: string, pack: string, sha: string): Promise<string> {
  const where = join(PACK_STORE, pack, sha);
  const text = await readFile(await confinedPath(home, where), "utf8").catch(() => null);
  if (text === null || sha256(text) !== sha) throw new ActionFailure(`The pinned copy ${where} is missing or changed on disk, so it is not used: restore it from a copy`);
  return text;
}

/** Fetches a file a pinned pack does not hold yet, keeps it, and adds it to the pin (a new pack is pinned this way). */
async function pinFile(home: string, url: string | undefined, ref: string, now: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const text = await fetchSkillswikiSolution(await skillswikiTarget(url), ref);
  const sha = await storeText(home, pack, text);
  const packs = await loadPacks(home);
  const current = packs[pack];
  const files = { ...(current?.files ?? {}), [`${skill}/${path}`]: sha };
  const pin: PackPin = { ...current, version: packVersion(files), files, pinned_at: current?.pinned_at ?? now };
  await savePacks(home, { ...packs, [pack]: pin });
  await appendAudit(home, { ts: now, actor: "engine", event: "pack.pinned", ref: `pack:${pack}`, payload: { file: `${skill}/${path}`, sha256: sha, version: pin.version } });
  return text;
}

/** The text a judge reads: the pinned copy, or the candidate's in a shadow run of that pack (D108). */
export async function pinnedSkill(home: string, url: string | undefined, ref: string, now: string, shadow?: string): Promise<string> {
  const { pack, skill, path } = parseSkillswikiRef(ref);
  const pin = (await loadPacks(home))[pack];
  const key = `${skill}/${path}`;
  const sha = (shadow === pack ? pin?.candidate?.files[key] : undefined) ?? pin?.files[key];
  return sha === undefined ? pinFile(home, url, ref, now) : storedText(home, pack, sha);
}

/** Fetches every pinned file again; a pack whose text changed gets (or keeps) a candidate. Returns the new candidates. */
export async function checkPacks(home: string, url: string | undefined, now: string): Promise<PackUpdate[]> {
  const packs = await loadPacks(home);
  if (Object.keys(packs).length === 0) return [];
  const target = await skillswikiTarget(url);
  const updates: PackUpdate[] = [];
  let next: Packs = packs;
  for (const [pack, pin] of Object.entries(packs)) {
    const files: Record<string, string> = {};
    for (const key of Object.keys(pin.files)) files[key] = await storeText(home, pack, await fetchSkillswikiSolution(target, `skillswiki:${pack}/${key}`));
    const version = packVersion(files);
    if (version === pin.version || version === pin.candidate?.version) continue;
    const update = { pack, from: pin.version, to: version, changed: Object.keys(files).filter((key) => files[key] !== pin.files[key]) };
    next = { ...next, [pack]: { ...pin, candidate: { version, files, found_at: now } } };
    updates.push(update);
    await appendAudit(home, { ts: now, actor: "engine", event: "pack.update_found", ref: `pack:${pack}`, payload: update });
  }
  if (updates.length > 0) await savePacks(home, next);
  return updates;
}
