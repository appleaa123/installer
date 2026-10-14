import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { requireEntity, type DataContract, type EntityDef } from "./contract.js";
import { loadConnector } from "./connectors.js";
import { removeStaleTemps, syncDirectory, writeSynced } from "./durable.js";
import { connectorTokens } from "./google-auth.js";
import { InputError } from "./inputs.js";
import { loadPinnedContract } from "./pin.js";
import { sheetsClient, type SheetLocation, type SheetsClient } from "./sheets.js";
import { StateCorruptError } from "./state.js";

/**
 * Where each entity's records live (§9.4, D68): `config/sources/<entity>.json` names the pinned connector and the
 * spreadsheet; `config/mapping/<entity>.json` maps contract fields to the client's column names. No secrets.
 */
export const SOURCES_DIR = join("config", "sources");
export const MAPPING_DIR = join("config", "mapping");
/** The one records connector of v1 (D65); Microsoft Excel is deferred (D69). */
export const SHEETS_CONNECTOR = { id: "google-sheets", version: "1" } as const;

export interface DataSource extends SheetLocation {
  readonly entity: string;
  readonly connector: { readonly id: string; readonly version: string; readonly sha256: string };
  readonly url?: string;
}

export interface Mapping {
  readonly entity: string;
  /** Contract field → the exact column name in row 1 of the sheet. */
  readonly columns: Readonly<Record<string, string>>;
}

type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON file under the home (D34); null when it does not exist. */
export async function readConfig(home: string, relative: string): Promise<unknown> {
  const path = await confinedPath(home, relative);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StateCorruptError(`${path} is not valid JSON; it was not changed. Remove it and run the command that wrote it again.`);
  }
}

/** Atomic write: synced temp file, rename, directory sync (0600 in a 0700 folder, D34). */
export async function writeConfig(home: string, relative: string, value: unknown): Promise<void> {
  const target = await confinedPath(home, relative);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await removeStaleTemps(dirname(target), basename(target));
  const temp = `${target}.${process.pid}.tmp`;
  await writeSynced(temp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temp, target);
  await syncDirectory(dirname(target));
}

const sourceFile = (entity: string): string => join(SOURCES_DIR, `${entity}.json`);
const mappingFile = (entity: string): string => join(MAPPING_DIR, `${entity}.json`);

function damaged(what: string, entity: string): never {
  throw new StateCorruptError(`The ${what} of '${entity}' under config/ has an unexpected shape; remove it and run the command again`);
}

export async function loadSource(home: string, entity: string): Promise<DataSource | null> {
  const raw = await readConfig(home, sourceFile(entity));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.entity !== entity || typeof raw.spreadsheet_id !== "string" || !isRecord(raw.connector)) return damaged("data source", entity);
  return raw as unknown as DataSource;
}

export async function loadMapping(home: string, entity: string): Promise<Mapping | null> {
  const raw = await readConfig(home, mappingFile(entity));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.entity !== entity || !isRecord(raw.columns) || !Object.values(raw.columns).every((column) => typeof column === "string")) return damaged("mapping", entity);
  return raw as unknown as Mapping;
}

export const saveSource = (home: string, source: DataSource): Promise<void> => writeConfig(home, sourceFile(source.entity), source);
export const saveMapping = (home: string, mapping: Mapping): Promise<void> => writeConfig(home, mappingFile(mapping.entity), mapping);
export const removeMapping = async (home: string, entity: string): Promise<void> => rm(await confinedPath(home, mappingFile(entity)), { force: true });

/** The pinned contract and one of its entities; a solution without a contract has nothing to connect. */
export async function contractEntity(home: string, entity: string): Promise<{ contract: DataContract; entity: EntityDef }> {
  const contract = await loadPinnedContract(home);
  if (!contract) throw new InputError("This solution declares no data contract, so it has no records to connect");
  return { contract, entity: requireEntity(contract, entity) };
}

/** A Sheets client for the pinned connector (checksum checked on every load) and the stored sign-in. */
export async function openSheets(env: Env = process.env): Promise<{ sheets: SheetsClient; sha256: string }> {
  const def = await loadConnector(SHEETS_CONNECTOR.id, SHEETS_CONNECTOR.version);
  return { sheets: sheetsClient(def, await connectorTokens(def, env), env), sha256: def.sha256 };
}

/** Field problems of a mapping against the contract: unknown fields, required fields left out. */
export function mappingProblem(entity: EntityDef, columns: Readonly<Record<string, string>>): string | null {
  const unknown = Object.keys(columns).find((field) => !Object.hasOwn(entity.fields, field));
  if (unknown !== undefined) return `'${unknown}' is not a field; fields: ${Object.keys(entity.fields).join(", ")}`;
  const missing = Object.keys(entity.fields).find((field) => entity.fields[field]?.required && !Object.hasOwn(columns, field));
  return missing === undefined ? null : `the required field '${missing}' has no column`;
}

/** `source_present` (§9.4 step 2): the entity is connected to a spreadsheet. */
export async function sourceCheck(home: string, entity: string): Promise<{ ok: boolean; hint?: string }> {
  if (await loadSource(home, entity)) return { ok: true };
  return { ok: false, hint: `'${entity}' is not connected yet: run 'taskfollow connect ${entity} --sheet <link of the Google Sheet>' (or --sheet new), then the verify again` };
}

/** `mapping_present` (§9.4 step 4): every required field maps to a column. */
export async function mappingCheck(home: string, entity: string): Promise<{ ok: boolean; hint?: string }> {
  const mapping = await loadMapping(home, entity);
  const problem = mapping ? mappingProblem((await contractEntity(home, entity)).entity, mapping.columns) : "no mapping is saved";
  if (problem === null) return { ok: true };
  return { ok: false, hint: `The columns of '${entity}' are not mapped (${problem}): run 'taskfollow map ${entity}', confirm the mapping with the person, then 'taskfollow map ${entity} --value <json>' and the verify again` };
}
