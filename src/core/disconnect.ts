import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendAudit } from "./audit.js";
import { CONNECTOR_PINS, loadConnector, type ConnectorDef } from "./connectors.js";
import { InputError } from "./inputs.js";
import { deleteSecret } from "./keychain.js";
import { PROFILE_DIR_ENV, listBundledProfiles, loadProfile, loadProfileById, type RuntimeProfile } from "./profile.js";
import { unregisterMcp } from "./register.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID } from "./skillswiki.js";
import { loadState } from "./state.js";

export interface Disconnected {
  readonly status: "disconnected";
  readonly unregistered: boolean;
  readonly secret_deleted: boolean;
  readonly note?: string;
}

export interface ConnectorDisconnected {
  readonly status: "disconnected";
  readonly connector: string;
  readonly secret_deleted: boolean;
  readonly note: string;
}

/** Where a person removes an app's access to their Google account; the installer calls no Google endpoint for it (D67). */
export const GOOGLE_ACCESS_PAGE = "https://myaccount.google.com/connections";

/**
 * The agent this home recorded; without one, every profile that can remove a server: the operator's
 * INSTALLER_PROFILE_DIR when set (tests rely on it so they never touch the real agent), else the bundled ones.
 */
async function candidateProfiles(profileId: string | null | undefined): Promise<RuntimeProfile[]> {
  if (profileId) return [await loadProfileById(profileId)];
  const extra = process.env[PROFILE_DIR_ENV];
  if (!extra) return listBundledProfiles();
  const dir = resolve(extra);
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(names.map((name) => loadProfile(join(dir, name))));
}

/** The registration is user-wide (D52), so it is removed whatever home this runs from; a failure never keeps the key. */
async function unregisterEverywhere(home: string, profileId: string | null | undefined): Promise<{ readonly unregistered: boolean; readonly note?: string }> {
  try {
    const profiles = (await candidateProfiles(profileId)).filter((profile) => profile.mcp_remove);
    let unregistered = false;
    for (const profile of profiles) unregistered = (await unregisterMcp(profile, SKILLSWIKI_MCP_NAME, home)) || unregistered;
    return { unregistered };
  } catch (error) {
    return { unregistered: false, note: `Could not remove the agent's Skills Wiki registration (${(error as Error).message})` };
  }
}

/** The newest pinned version of a connector, or a usage error naming what can be disconnected. */
async function connectorNamed(id: string): Promise<ConnectorDef> {
  const versions = Object.hasOwn(CONNECTOR_PINS, id) ? Object.keys(CONNECTOR_PINS[id] ?? {}) : [];
  const newest = [...versions].sort((a, b) => Number(b) - Number(a))[0];
  if (newest === undefined) throw new InputError(`'${id}' cannot be disconnected; this version can disconnect: ${[SKILLSWIKI_SECRET_ID, ...Object.keys(CONNECTOR_PINS)].join(", ")}`);
  return loadConnector(id, newest);
}

/** `installer disconnect <connector>` (§14.2): delete its sign-in from the keychain and audit it; the person removes the grant at the provider. */
async function disconnectConnector(home: string, id: string, now: () => string): Promise<ConnectorDisconnected> {
  const def = await connectorNamed(id);
  const deleted = await deleteSecret(def.auth.secret_id);
  if (await loadState(home)) await appendAudit(home, { ts: now(), actor: "human", event: "connector.disconnected", ref: id, payload: { secret_deleted: deleted } });
  const note = `The installer deleted its ${def.name} sign-in from this computer. To remove its access from your Google account as well, open ${GOOGLE_ACCESS_PAGE} and remove your OAuth app there.`;
  return { status: "disconnected", connector: id, secret_deleted: deleted, note };
}

/** Revoke and delete (D34, §14.2): remove the server from the probed agent, delete the keychain item, record it in the audit. */
export async function disconnect(home: string, id: string, now: () => string): Promise<Disconnected | ConnectorDisconnected> {
  if (id !== SKILLSWIKI_SECRET_ID) return disconnectConnector(home, id, now);
  const state = await loadState(home);
  const { unregistered, note } = await unregisterEverywhere(home, state?.runtime?.profile);
  const deleted = await deleteSecret(id);
  if (state) await appendAudit(home, { ts: now(), actor: "human", event: "secret.disconnected", ref: id, payload: { unregistered, secret_deleted: deleted } });
  return { status: "disconnected", unregistered, secret_deleted: deleted, ...(note ? { note } : {}) };
}
