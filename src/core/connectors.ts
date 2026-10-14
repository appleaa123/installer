import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";

/**
 * Connector packages (spec §8.1–8.2, D65): v1 connectors are data files shipped inside the installer package,
 * `connectors/<id>/<version>/connector.json`, each pinned below to the sha256 of its exact bytes. A file that
 * differs from its pin is never used. Remote download and signed updates arrive with pack pinning (Plan 9).
 */
export const CONNECTORS_DIR = fileURLToPath(new URL("../../connectors/", import.meta.url));

/** The curated catalog (§8.2): id → version → sha256 of the definition file. */
export type ConnectorPins = Readonly<Record<string, Readonly<Record<string, string>>>>;
export const CONNECTOR_PINS: ConnectorPins = {
  "google-sheets": { "1": "1a444eba44a221a24b52517b3fba563b3f3e2e273332164bb85d8b3f925341ce" },
};

/** Built-in adapters a definition may name; a connector is data, the code that speaks its API is the engine's. */
export const ADAPTERS = ["google_sheets"] as const;
export type Adapter = (typeof ADAPTERS)[number];

export interface ConnectorAuth {
  readonly kind: "oauth2";
  readonly provider: string;
  /** The keychain item that holds this connector's sign-in (`taskfollow secret <secret_id>`). */
  readonly secret_id: string;
  readonly scopes: readonly string[];
  readonly authorize_url: string;
  readonly token_url: string;
}

/** One known problem: Google's code, what it means, how to fix it, where to look and what to search for (live setup guides, 4.2). */
export interface ConnectorSymptom {
  readonly match: string;
  readonly means: string;
  readonly fix: string;
  readonly look: string;
  readonly search: string;
}

/** What a person needs to set the connector up, as facts that outlive a redesign of the provider's console (live setup guides, 4.2). */
export interface ConnectorSetup {
  readonly title: string;
  readonly outcome: readonly string[];
  readonly sources: readonly string[];
  readonly symptoms: readonly ConnectorSymptom[];
  /** Optional numbered fallback for an agent that cannot read the provider's pages; menu names may be out of date. */
  readonly steps?: readonly string[];
}

export interface ConnectorDef {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly interface: readonly ["records_source"];
  readonly adapter: Adapter;
  readonly api: { readonly base_url: string };
  readonly auth: ConnectorAuth;
  readonly risk: { readonly reads_personal_data: boolean; readonly outbound_external: boolean; readonly official_api: boolean };
  /** The step-by-step help the agent reads at install time (`taskfollow guide`); a connector may have none. */
  readonly setup?: ConnectorSetup;
  /** The checksum the file matched when it was loaded. */
  readonly sha256: string;
}

const ID = /^[a-z0-9-]+$/;
const VERSION = /^[0-9]+$/;
const SERVER_ENV = "INSTALLER_CONNECTOR_SERVER";
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;
type Raw = Record<string, unknown>;
type Env = Readonly<Record<string, string | undefined>>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function httpsUrl(value: unknown, where: string, fail: (message: string) => never): string {
  if (typeof value !== "string" || !value.startsWith("https://")) return fail(`${where} must be an https URL`);
  return value;
}

function parseAuth(value: unknown, fail: (message: string) => never): ConnectorAuth {
  if (!isRecord(value) || value.kind !== "oauth2") return fail("auth.kind must be oauth2");
  const { provider, secret_id: secretId, scopes } = value;
  if (typeof provider !== "string" || typeof secretId !== "string" || !ID.test(secretId)) return fail("auth needs a provider and a secret_id of lowercase letters, digits and dashes");
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === "string")) return fail("auth.scopes must list at least one scope");
  return {
    kind: "oauth2", provider, secret_id: secretId, scopes: scopes as string[],
    authorize_url: httpsUrl(value.authorize_url, "auth.authorize_url", fail), token_url: httpsUrl(value.token_url, "auth.token_url", fail),
  };
}

const GOOGLE_HOST = /(^|\.)google\.com$/;

function googleUrl(value: unknown, where: string, fail: (message: string) => never): string {
  const url = httpsUrl(value, where, fail);
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return fail(`${where} is not a valid URL`);
  }
  return GOOGLE_HOST.test(host) ? url : fail(`${where} must be on a google.com address`);
}

function setupText(value: unknown, where: string, fail: (message: string) => never): string {
  return typeof value === "string" && value.trim() !== "" ? value : fail(`${where} must be a non-empty string`);
}

function setupList(value: unknown, where: string, fail: (message: string) => never): readonly unknown[] {
  return Array.isArray(value) && value.length > 0 ? value : fail(`${where} must list at least one item`);
}

function parseSymptom(value: unknown, index: number, fail: (message: string) => never): ConnectorSymptom {
  const where = `setup.symptoms[${index}]`;
  if (!isRecord(value)) return fail(`${where} must be an object`);
  return {
    match: setupText(value.match, `${where}.match`, fail), means: setupText(value.means, `${where}.means`, fail),
    fix: setupText(value.fix, `${where}.fix`, fail), look: setupText(value.look, `${where}.look`, fail), search: setupText(value.search, `${where}.search`, fail),
  };
}

function parseSetup(value: unknown, fail: (message: string) => never): ConnectorSetup | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return fail("setup must be an object");
  return {
    title: setupText(value.title, "setup.title", fail),
    outcome: setupList(value.outcome, "setup.outcome", fail).map((item, index) => setupText(item, `setup.outcome[${index}]`, fail)),
    sources: setupList(value.sources, "setup.sources", fail).map((item, index) => googleUrl(item, `setup.sources[${index}]`, fail)),
    symptoms: setupList(value.symptoms, "setup.symptoms", fail).map((item, index) => parseSymptom(item, index, fail)),
    ...(value.steps === undefined ? {} : { steps: setupList(value.steps, "setup.steps", fail).map((item, index) => setupText(item, `setup.steps[${index}]`, fail)) }),
  };
}

function parseConnector(text: string, id: string, version: string, checksum: string): ConnectorDef {
  const fail = (message: string): never => {
    throw new ActionFailure(`The connector package ${id}@${version} is not usable: ${message}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(raw)) return fail("not a JSON object");
  if (raw.id !== id || raw.version !== version) fail(`it declares id '${String(raw.id)}' version '${String(raw.version)}'`);
  if (!(ADAPTERS as readonly unknown[]).includes(raw.adapter)) fail(`adapter must be one of ${ADAPTERS.join(", ")}`);
  if (JSON.stringify(raw.interface) !== JSON.stringify(["records_source"])) fail('interface must be ["records_source"]');
  const api = isRecord(raw.api) ? raw.api : {};
  const risk = isRecord(raw.risk) ? raw.risk : {};
  const flags = ["reads_personal_data", "outbound_external", "official_api"] as const;
  if (!flags.every((flag) => typeof risk[flag] === "boolean")) fail(`risk must say true or false for ${flags.join(", ")}`);
  const setup = parseSetup(raw.setup, fail);
  return {
    id, version, name: typeof raw.name === "string" ? raw.name : id, interface: ["records_source"], adapter: raw.adapter as Adapter,
    api: { base_url: httpsUrl(api.base_url, "api.base_url", fail) }, auth: parseAuth(raw.auth, fail),
    risk: { reads_personal_data: risk.reads_personal_data as boolean, outbound_external: risk.outbound_external as boolean, official_api: risk.official_api as boolean },
    ...(setup ? { setup } : {}),
    sha256: checksum,
  };
}

function catalogList(pins: ConnectorPins): string {
  return Object.entries(pins).flatMap(([id, versions]) => Object.keys(versions).map((version) => `${id}@${version}`)).join(", ");
}

/** Reads `<root>/<id>/<version>/connector.json` and uses it only when its sha256 equals the pin (D34, §14.2). */
export async function loadConnector(id: string, version: string, root: string = CONNECTORS_DIR, pins: ConnectorPins = CONNECTOR_PINS): Promise<ConnectorDef> {
  if (!ID.test(id)) throw new InputError(`Connector id '${id}' must be lowercase letters, digits and dashes`);
  if (!VERSION.test(version)) throw new InputError(`Connector version '${version}' must be a whole number`);
  const pinned = Object.hasOwn(pins, id) && Object.hasOwn(pins[id] ?? {}, version) ? pins[id]?.[version] : undefined;
  if (!pinned) throw new InputError(`Connector ${id}@${version} is not in this installer's catalog; it has: ${catalogList(pins)}`);
  const path = join(root, id, version, "connector.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ActionFailure(`The connector package ${id}@${version} is missing from this installation (${path}); reinstall the installer`);
  }
  const found = sha256(text);
  if (found !== pinned) throw new ActionFailure(`The connector package ${id}@${version} does not match its pinned checksum (expected sha256:${pinned}, found sha256:${found}); it was not used. Reinstall the installer`);
  return parseConnector(text, id, version, found);
}

/** Which keychain item each pinned connector signs in with, known without reading any connector file (review finding 3). */
export const CONNECTOR_SECRETS: Readonly<Record<string, string>> = { "google-sheets": "google" };

export function newestVersion(id: string, pins: ConnectorPins = CONNECTOR_PINS): string | undefined {
  return Object.keys(Object.hasOwn(pins, id) ? (pins[id] ?? {}) : {}).sort((a, b) => Number(b) - Number(a))[0];
}

/** The newest pinned connector that signs in with this keychain item over OAuth, or null when none does. */
export async function oauthConnectorFor(secretId: string): Promise<ConnectorDef | null> {
  const id = Object.keys(CONNECTOR_SECRETS).find((name) => CONNECTOR_SECRETS[name] === secretId);
  const version = id === undefined ? undefined : newestVersion(id);
  return id === undefined || version === undefined ? null : loadConnector(id, version);
}

/** Tests point every connector URL at one loopback fake server; nothing else can redirect them. */
export function connectorUrl(url: string, env: Env = process.env): string {
  const server = env[SERVER_ENV];
  if (!server) return url;
  if (env.INSTALLER_KEYCHAIN !== "file") {
    throw new InputError(`${SERVER_ENV} is only for tests with the throwaway file keychain (INSTALLER_KEYCHAIN=file); real sign-ins only ever go to Google (D67)`);
  }
  if (!LOOPBACK.test(server)) throw new InputError(`${SERVER_ENV} must be http://127.0.0.1:<port> (a test server on this machine), got '${server}'`);
  return `${server}${new URL(url).pathname}`;
}
