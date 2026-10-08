import { appendAudit } from "./audit.js";
import { InputError } from "./inputs.js";
import { deleteSecret } from "./keychain.js";
import { loadProfileById } from "./profile.js";
import { unregisterMcp } from "./register.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID } from "./skillswiki.js";
import { loadState } from "./state.js";

export interface Disconnected {
  readonly status: "disconnected";
  readonly unregistered: boolean;
  readonly secret_deleted: boolean;
}

/** Revoke and delete (D34, §14.2): remove the server from the probed agent, delete the keychain item, record it in the audit. */
export async function disconnect(home: string, id: string, now: () => string): Promise<Disconnected> {
  if (id !== SKILLSWIKI_SECRET_ID) throw new InputError(`Only '${SKILLSWIKI_SECRET_ID}' can be disconnected in this version`);
  const state = await loadState(home);
  const profileId = state?.runtime?.profile;
  const unregistered = profileId ? await unregisterMcp(await loadProfileById(profileId), SKILLSWIKI_MCP_NAME, home) : false;
  const deleted = await deleteSecret(id);
  if (state) await appendAudit(home, { ts: now(), actor: "human", event: "secret.disconnected", ref: id, payload: { unregistered, secret_deleted: deleted } });
  return { status: "disconnected", unregistered, secret_deleted: deleted };
}
