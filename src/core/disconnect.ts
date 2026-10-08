import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendAudit } from "./audit.js";
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

/** Revoke and delete (D34, §14.2): remove the server from the probed agent, delete the keychain item, record it in the audit. */
export async function disconnect(home: string, id: string, now: () => string): Promise<Disconnected> {
  if (id !== SKILLSWIKI_SECRET_ID) throw new InputError(`Only '${SKILLSWIKI_SECRET_ID}' can be disconnected in this version`);
  const state = await loadState(home);
  const { unregistered, note } = await unregisterEverywhere(home, state?.runtime?.profile);
  const deleted = await deleteSecret(id);
  if (state) await appendAudit(home, { ts: now(), actor: "human", event: "secret.disconnected", ref: id, payload: { unregistered, secret_deleted: deleted } });
  return { status: "disconnected", unregistered, secret_deleted: deleted, ...(note ? { note } : {}) };
}
