import { appendAudit } from "./audit.js";
import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentOf, CHECK_TTL_MS, type CheckContext } from "./check-commands.js";
import { plantMessage, plantByChannel, SUBJECT_PREFIX } from "./check-plant.js";
import { loadChallenge, recordResult, saveChallenge, startChallenge, type Challenge, type Need } from "./checks.js";
import { readConfig, SOURCES_DIR } from "./data-source.js";
import { confinedPath } from "./actions.js";
import { loadProfileById } from "./profile.js";
import { skillRoots } from "./skills.js";
import type { SheetsClient } from "./sheets.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * T2's other variants (spec 5.2, item 7a): an email attachment, a file, a sheet tab. Each puts the word only where the
 * ability under test reads it (inside an attached file, a file in a folder TaskFollow made, cell A1 of a tab TaskFollow
 * added), never in an output an agent sees, and removes what it made once the check ends.
 */
type Raw = Record<string, unknown>;
export const CHECK_FOLDER = "taskfollow-check";

export interface SheetTarget {
  readonly client: SheetsClient;
  readonly spreadsheet_id: string;
}

const answerLine = (id: string): string => `then run: taskfollow check answer ${id} '<the word>'`;

/** Where test files go: the install folder's `taskfollow-check/`, or under the TaskFollow home on a home-folder install (never `~`). */
export async function checkFolder(home: string, state: InstallState | undefined): Promise<string> {
  const profile = state?.runtime?.profile ? await loadProfileById(state.runtime.profile).catch(() => null) : null;
  const roots = skillRoots(profile ?? undefined, state?.work_dir, process.env);
  const base = state?.work_dir && !roots.home_folder ? state.work_dir : home;
  const folder = join(base, CHECK_FOLDER);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

async function workflowOf(home: string, flags: Raw): Promise<string | undefined> {
  return typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
}

async function begin(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext, test: string, need: Need): Promise<{ challenge: Challenge; word: string }> {
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const workflow = await workflowOf(home, flags);
  const { challenge, word } = await startChallenge(home, { needs: [need], test, ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  return { challenge, word: word ?? "" };
}

/** T2 files: the word inside a file in a folder TaskFollow made. */
export async function startReadsFiles(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const { challenge, word } = await begin(home, state, flags, context, "t2f", "reads:files");
  const file = join(await checkFolder(home, state), `${randomBytes(6).toString("hex")}.txt`);
  await writeFile(file, `${word}\n`, { mode: 0o600 });
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), file } });
  return { id: challenge.id, test: "t2f", instruction: `Read the file ${file}, ${answerLine(challenge.id)} (the word is its only text).` };
}

/** T2 attachment: the subject carries only the check's id; the word is inside the attached file. */
export async function startReadsAttachment(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const { challenge, word } = await begin(home, state, flags, context, "t2a", "reads:email-attachment");
  const subject = `${SUBJECT_PREFIX} ${challenge.id}`;
  const instruction = `Find the newest email whose subject is "${subject}", open its attached file, ${answerLine(challenge.id)} (the word is the file's only text). If you cannot read email attachments, run: taskfollow check cannot ${challenge.id}`;
  const files = [{ filename: `taskfollow-check-${challenge.id}.txt`, type: "text/plain", bytes: Buffer.from(`${word}\n`, "utf8") }];
  const text = "This is a test email from TaskFollow, sent to your own address to check what your assistant can do. The attached file holds a word. You can delete this email.";
  if (await plantMessage(home, context.plant ?? plantByChannel, { id: challenge.id, subject, text, test: "t2a", files }, context.now())) {
    return { id: challenge.id, test: "t2a", instruction, planted: "TaskFollow sent the test email with its file to your own address; give it a minute to arrive" };
  }
  const launched = await context.launch(home, challenge.id, word);
  return { id: challenge.id, test: "t2a", instruction, page: launched.opened ? "opened in the person's browser: they download a small file there and email it to themselves, then tell you" : `ask the person to run 'taskfollow check page ${challenge.id}' in their own terminal` };
}

/** The connected spreadsheet and a client for it, through TaskFollow's own Sheets connection; null without one. */
export async function connectedSheet(home: string): Promise<SheetTarget | null> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, SOURCES_DIR))).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return null;
  }
  for (const name of names) {
    const source = (await readConfig(home, join(SOURCES_DIR, name))) as { spreadsheet_id?: unknown } | null;
    if (typeof source?.spreadsheet_id === "string") {
      const { openSheets } = await import("./data-source.js");
      return { client: (await openSheets()).sheets, spreadsheet_id: source.spreadsheet_id };
    }
  }
  return null;
}

const NO_SHEET = "Not checked: TaskFollow can only test records in a sheet tab it made, through its own Google Sheets connection, and none is connected";

/** T2 records: a tab TaskFollow adds at the end of the connected spreadsheet, with the word in A1. */
export async function startReadsRecords(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const target = await (context.sheets ?? connectedSheet)(home);
  if (!target?.client.addTab) {
    const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
    const workflow = await workflowOf(home, flags);
    await recordResult(home, { need: "reads:records", ...(workflow ? { workflow } : {}), result: "not-checked", reason: NO_SHEET, at: context.now(), agent, agent_version: version, test: "t2r" });
    return { need: "reads:records", result: "not checked", why: NO_SHEET };
  }
  const { challenge, word } = await begin(home, state, flags, context, "t2r", "reads:records");
  const tab = `taskfollow-check-${challenge.id}`;
  const sheetId = await target.client.addTab(target.spreadsheet_id, tab);
  await target.client.writeRow({ spreadsheet_id: target.spreadsheet_id, tab }, 1, [word]);
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), tab, tab_id: String(sheetId), spreadsheet: target.spreadsheet_id } });
  return { id: challenge.id, test: "t2r", instruction: `Open the tab "${tab}" in the spreadsheet TaskFollow uses (id ${target.spreadsheet_id}), read cell A1, ${answerLine(challenge.id)}. If you cannot read spreadsheets yourself, say so.` };
}

/**
 * A check that made a tab removes it once the check is no longer open, however it ended (answer, mark, ping, the
 * sweep): TaskFollow's own tab only (review 3 of PR #54). A Sheets error is audited, and the tab stays recorded so the
 * sweep tries again; it never undoes a recorded answer.
 */
export async function cleanupTab(home: string, id: string, sheets?: () => Promise<SheetTarget | null>): Promise<void> {
  const challenge = await loadChallenge(home, id);
  const details = challenge?.details;
  if (!challenge || challenge.status === "open" || !details?.tab_id || !details.spreadsheet || !details.tab?.startsWith("taskfollow-check-")) return;
  try {
    const target = await (sheets ?? (() => connectedSheet(home)))();
    if (!target?.client.deleteTab || target.spreadsheet_id !== details.spreadsheet) return;
    await target.client.deleteTab(details.spreadsheet, Number(details.tab_id));
  } catch (error) {
    await appendAudit(home, { ts: new Date().toISOString(), actor: "engine", event: "check.cleanup_failed", ref: `check:${id}`, payload: { what: "tab", why: (error as Error).message } });
    return;
  }
  const { tab_id: _tabId, ...rest } = details;
  await saveChallenge(home, { ...challenge, details: rest });
}

/** The command's own Sheets access (tests inject it), for cleanupTab. */
export const removeTab = (home: string, id: string, context: CheckContext): Promise<void> => {
  const sheets = context.sheets;
  return cleanupTab(home, id, sheets ? () => sheets(home) : undefined);
};
