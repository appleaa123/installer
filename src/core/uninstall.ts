import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { AUDIT_FILE, appendAudit, verifyAudit, withAuditLock } from "./audit.js";
import { CHANNEL_IDS } from "./channels.js";
import { CONNECTOR_SECRETS } from "./connectors.js";
import { unregisterEverywhere } from "./disconnect.js";
import { ActionFailure } from "./failure.js";
import { stopGateway } from "./gateway-process.js";
import { serviceCommand, type ServiceOptions } from "./host-service.js";
import { InputError } from "./inputs.js";
import { deleteSecret } from "./keychain.js";
import { MODEL_SECRET_ID } from "./model.js";
import { setPaused } from "./pause.js";
import { TOOLS_MCP_NAME } from "./register.js";
import { scheduleCommand } from "./scheduler.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID } from "./skillswiki.js";
import { loadState } from "./state.js";

/**
 * `taskfollow uninstall` (spec §16.4, D34, D109): removes the engine's body and keeps the records. In order: pause, so
 * nothing goes out from here on (D101); stop the gateway; remove the agent's MCP registrations (`skillswiki`,
 * `installer`); delete the keychain items the engine stored; delete the schedule and boot service files it wrote
 * under the home; audit it; export the audit to `exports/`. It prints the OS commands that unload what a person
 * loaded, because the engine never changes the OS itself. Business records (the client's sheets and mailboxes,
 * `data/`, run logs) are not touched, and the home stays until the person deletes it. Only a person, in a terminal.
 */
export const EXPORTS_DIR = "exports";
export const ENGINE_SECRETS: readonly string[] = [SKILLSWIKI_SECRET_ID, ...CHANNEL_IDS, ...Object.values(CONNECTOR_SECRETS), MODEL_SECRET_ID];

type Env = Readonly<Record<string, string | undefined>>;
const stamp = (now: string): string => now.replace(/[:.]/g, "-");

/** A copy of the audit under `exports/` (0600), taken under the audit lock, with its chain checked. */
export async function exportAudit(home: string, now: string): Promise<{ file: string; lines: number; chain: string }> {
  const target = await confinedPath(home, join(EXPORTS_DIR, `audit-${stamp(now)}.jsonl`));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const check = await withAuditLock(home, async () => {
    await writeFile(target, await readFile(await confinedPath(home, AUDIT_FILE), "utf8"), { encoding: "utf8", mode: 0o600 });
    return verifyAudit(home);
  });
  return { file: target, lines: check.ok ? check.lines : 0, chain: check.ok ? "intact" : `broken at line ${check.line}: ${check.reason}` };
}

async function deleteSecrets(env: Env | undefined): Promise<Record<string, string>> {
  const outcome: Record<string, string> = {};
  for (const id of ENGINE_SECRETS) {
    try {
      outcome[id] = (await deleteSecret(id, env)) ? "deleted" : "none";
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
      outcome[id] = `not deleted: ${error.message}`;
    }
  }
  return outcome;
}

/** The schedule entry and the boot services: files under the home go, the OS commands are printed. */
async function osCommands(home: string, now: () => string, options: ServiceOptions): Promise<string[]> {
  const commands: string[] = [];
  for (const remove of [() => scheduleCommand(home, "remove", undefined, now, options), () => serviceCommand(home, "remove", options, now)]) {
    try {
      commands.push(...((await remove()).commands as string[]));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return commands;
}

export async function uninstall(home: string, person: { interactive: boolean; as?: string }, now: () => string, options: ServiceOptions & { env?: Env } = {}): Promise<Record<string, unknown>> {
  if (!person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "engine.uninstall_refused", ref: "uninstall", payload: { command: "taskfollow uninstall" } });
    throw new InputError("Uninstalling removes the engine's registrations, keys and schedules: the person runs 'taskfollow uninstall' in their own terminal");
  }
  const by = person.as?.trim() || "terminal";
  await setPaused(home, true, { name: by, actor: "human", via: "cli" }, now(), "uninstall");
  const gateway = (await stopGateway(home, now)).status;
  const profile = (await loadState(home))?.runtime?.profile;
  const unregistered = { [SKILLSWIKI_MCP_NAME]: await unregisterEverywhere(home, profile, SKILLSWIKI_MCP_NAME), [TOOLS_MCP_NAME]: await unregisterEverywhere(home, profile, TOOLS_MCP_NAME) };
  const secrets = await deleteSecrets(options.env);
  const commands = await osCommands(home, now, options);
  await appendAudit(home, { ts: now(), actor: "human", event: "engine.uninstalled", ref: "uninstall", payload: { by, gateway, unregistered, secrets } });
  return {
    status: "uninstalled", gateway, unregistered, secrets, audit_export: await exportAudit(home, now()), commands,
    kept: ["the client's own sheets and mailboxes (never touched)", "data/ and runs/ under the home", "the audit, exported as above"],
    note: "Run the printed commands in your own terminal to unload what was loaded into the OS; once you have kept the audit export, delete the home folder yourself.",
  };
}
