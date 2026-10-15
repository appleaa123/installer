import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { connectorUrl } from "./connectors.js";
import { ActionFailure } from "./failure.js";
import { RELAY_FILE, RELAY_SHA256 } from "./whatsapp.js";

/**
 * Puts TaskFollow's relay into the client's own Cloudflare account (D149) with the API token they paste on the setup
 * page; the token is used for these calls only and never stored. It finds the account, reuses or creates the D1
 * database `taskfollow-whatsapp` and its table, uploads exactly the pinned relay file with its three secrets (or, on
 * a re-run, keeps the secrets Meta already has), makes sure the account has a workers.dev address, and switches the
 * relay on there. The callback address carries the relay's secret path key, so it cannot be guessed.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
export const RELAY_NAME = "taskfollow-whatsapp";
const COMPATIBILITY_DATE = "2026-09-01";
const MODULE_NAME = "whatsapp-relay.mjs";
const CALL_TIMEOUT_MS = 60_000;
/** The relay's three secrets: Meta's handshake token, the computer's pull token, the callback's path key. */
export interface RelaySecrets {
  readonly verify_token: string;
  readonly pull_token: string;
  readonly path_key: string;
}

export const newRelaySecrets = (): RelaySecrets => ({ verify_token: randomBytes(16).toString("hex"), pull_token: randomBytes(24).toString("hex"), path_key: randomBytes(16).toString("hex") });

async function call(token: string, method: string, path: string, body: unknown, env: Env): Promise<unknown> {
  const isForm = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(connectorUrl(`${CLOUDFLARE_API}${path}`, env), {
      method, headers: { authorization: `Bearer ${token}`, ...(isForm || body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: isForm ? body : JSON.stringify(body) }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Cloudflare (${(error as Error).message})`);
  }
  const json: unknown = await response.json().catch(() => null);
  if (isRecord(json) && json.success === true) return json.result;
  if (response.status === 401 || response.status === 403) throw new ActionFailure("Cloudflare did not accept the token: make an API token with the permissions the page lists (Workers Scripts: Edit, D1: Edit, Account Settings: Read) and paste it again");
  const first = isRecord(json) && Array.isArray(json.errors) && isRecord(json.errors[0]) ? json.errors[0] : {};
  throw new ActionFailure(`Cloudflare refused a step (${String(first.code ?? response.status)}: ${String(first.message ?? "no details").slice(0, 120)})`);
}

async function relaySource(): Promise<Buffer> {
  const bytes = await readFile(fileURLToPath(new URL(`../../${RELAY_FILE}`, import.meta.url)));
  if (createHash("sha256").update(bytes).digest("hex") !== RELAY_SHA256) throw new ActionFailure("The relay file in this installation is not the one TaskFollow shipped: reinstall the taskfollow package");
  return bytes;
}

async function database(token: string, account: string, env: Env): Promise<string> {
  const listed = await call(token, "GET", `/accounts/${account}/d1/database?name=${RELAY_NAME}`, undefined, env);
  const found = Array.isArray(listed) ? listed.find((entry) => isRecord(entry) && entry.name === RELAY_NAME) : undefined;
  if (isRecord(found) && typeof found.uuid === "string") return found.uuid;
  const created = await call(token, "POST", `/accounts/${account}/d1/database`, { name: RELAY_NAME }, env);
  if (!isRecord(created) || typeof created.uuid !== "string") throw new ActionFailure("Cloudflare did not say which database it created");
  return created.uuid;
}

async function subdomain(token: string, account: string, env: Env): Promise<string> {
  try {
    const found = await call(token, "GET", `/accounts/${account}/workers/subdomain`, undefined, env);
    if (isRecord(found) && typeof found.subdomain === "string" && found.subdomain !== "") return found.subdomain;
  } catch (error) {
    if (!(error instanceof ActionFailure) || error.message.startsWith("Cloudflare did not accept")) throw error;
  }
  const made = await call(token, "PUT", `/accounts/${account}/workers/subdomain`, { subdomain: `tf-${randomBytes(4).toString("hex")}` }, env);
  if (!isRecord(made) || typeof made.subdomain !== "string") throw new ActionFailure("Cloudflare did not give this account a workers.dev address");
  return made.subdomain;
}

export async function deployRelay(token: string, request: { readonly secrets: RelaySecrets; readonly keep: boolean }, env: Env = process.env): Promise<{ readonly relay_url: string; readonly callback_url: string; readonly account: string }> {
  const accounts = await call(token, "GET", "/accounts", undefined, env);
  if (!Array.isArray(accounts) || accounts.length === 0 || !isRecord(accounts[0])) throw new ActionFailure("This Cloudflare token sees no account: make the token for your own account");
  if (accounts.length > 1) throw new ActionFailure("This Cloudflare token sees several accounts: make a token for the one account the relay should live in");
  const account = String(accounts[0].id);
  const db = await database(token, account, env);
  for (const sql of ["create table if not exists inbox (id integer primary key autoincrement, body text not null, size integer not null, signature text not null, received_at integer not null)", "create index if not exists inbox_received on inbox (received_at)"]) {
    await call(token, "POST", `/accounts/${account}/d1/database/${db}/query`, { sql }, env);
  }
  const secrets = request.keep ? [] : [["VERIFY_TOKEN", request.secrets.verify_token], ["PULL_TOKEN", request.secrets.pull_token], ["PATH_KEY", request.secrets.path_key]].map(([name, text]) => ({ type: "secret_text", name, text }));
  const metadata = { main_module: MODULE_NAME, compatibility_date: COMPATIBILITY_DATE, bindings: [{ type: "d1", name: "DB", database_id: db }, ...secrets], ...(request.keep ? { keep_bindings: ["secret_text"] } : {}) };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append(MODULE_NAME, new Blob([new Uint8Array(await relaySource())], { type: "application/javascript+module" }), MODULE_NAME);
  await call(token, "PUT", `/accounts/${account}/workers/scripts/${RELAY_NAME}`, form, env);
  const sub = await subdomain(token, account, env);
  await call(token, "POST", `/accounts/${account}/workers/scripts/${RELAY_NAME}/subdomain`, { enabled: true }, env);
  const relay = `https://${RELAY_NAME}.${sub}.workers.dev`;
  return { relay_url: relay, callback_url: `${relay}/webhook/${request.secrets.path_key}`, account: String(accounts[0].name ?? account) };
}
