import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendAudit } from "./audit.js";
import { CHANNEL_IDS, removeChannel, type ChannelId } from "./channels.js";
import { CONNECTOR_SECRETS, type ConnectorDef, loadConnector, newestVersion } from "./connectors.js";
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
export async function unregisterEverywhere(home: string, profileId: string | null | undefined, name: string = SKILLSWIKI_MCP_NAME): Promise<{ readonly unregistered: boolean; readonly note?: string }> {
  try {
    const profiles = (await candidateProfiles(profileId)).filter((profile) => profile.mcp_remove);
    let unregistered = false;
    for (const profile of profiles) unregistered = (await unregisterMcp(profile, name, home)) || unregistered;
    return { unregistered };
  } catch (error) {
    return { unregistered: false, note: `Could not remove the agent's '${name}' registration (${(error as Error).message})` };
  }
}

/** The connector's display name; a definition that fails to load must never stop the sign-in from being deleted. */
async function connectorName(id: string): Promise<{ readonly name: string; readonly problem?: string }> {
  const version = newestVersion(id);
  try {
    return { name: version === undefined ? id : (await loadConnector(id, version)).name };
  } catch (error) {
    return { name: id, problem: (error as Error).message };
  }
}

/** `taskfollow disconnect <connector>` (§14.2): delete its sign-in from the keychain first, then audit; the person removes the grant at the provider. */
async function disconnectConnector(home: string, id: string, now: () => string): Promise<ConnectorDisconnected> {
  if (!Object.hasOwn(CONNECTOR_SECRETS, id)) throw new InputError(`'${id}' cannot be disconnected; this version can disconnect: ${[SKILLSWIKI_SECRET_ID, ...CHANNEL_IDS, ...Object.keys(CONNECTOR_SECRETS)].join(", ")}`);
  const deleted = await deleteSecret(CONNECTOR_SECRETS[id] ?? id);
  const { name, problem } = await connectorName(id);
  if (await loadState(home)) await appendAudit(home, { ts: now(), actor: "human", event: "connector.disconnected", ref: id, payload: { secret_deleted: deleted } });
  const unreadable = problem ? ` Its definition could not be read (${problem}); reinstall the installer package.` : "";
  const note = `The installer deleted its ${name} sign-in from this computer. To remove its access from your Google account as well, open ${GOOGLE_ACCESS_PAGE} and remove your OAuth app there.${unreadable}`;
  return { status: "disconnected", connector: id, secret_deleted: deleted, note };
}

const CHANNEL_NOTES: Readonly<Record<ChannelId, string>> = {
  telegram: "The installer deleted the bot token and the channel's settings from this computer. If the token may have leaked, send /revoke to @BotFather so it stops working.",
  email: "The installer deleted the app password and the channel's settings from this computer. Delete the app password at your mail provider too, so it can no longer sign in.",
};

/** `taskfollow disconnect telegram | email` (§14.2): delete the secret and the channel's settings, and audit it. */
async function disconnectChannel(home: string, id: ChannelId, now: () => string): Promise<ConnectorDisconnected> {
  const deleted = await deleteSecret(id);
  const removed = await removeChannel(home, id);
  if (await loadState(home)) await appendAudit(home, { ts: now(), actor: "human", event: "channel.disconnected", ref: id, payload: { secret_deleted: deleted, settings_removed: removed } });
  return { status: "disconnected", connector: id, secret_deleted: deleted, note: CHANNEL_NOTES[id] };
}

/** Revoke and delete (D34, §14.2): remove the server from the probed agent, delete the keychain item, record it in the audit. */
export async function disconnect(home: string, id: string, now: () => string): Promise<Disconnected | ConnectorDisconnected> {
  if ((CHANNEL_IDS as readonly string[]).includes(id)) return disconnectChannel(home, id as ChannelId, now);
  if (id !== SKILLSWIKI_SECRET_ID) return disconnectConnector(home, id, now);
  const state = await loadState(home);
  const { unregistered, note } = await unregisterEverywhere(home, state?.runtime?.profile);
  const deleted = await deleteSecret(id);
  if (state) await appendAudit(home, { ts: now(), actor: "human", event: "secret.disconnected", ref: id, payload: { unregistered, secret_deleted: deleted } });
  return { status: "disconnected", unregistered, secret_deleted: deleted, ...(note ? { note } : {}) };
}
