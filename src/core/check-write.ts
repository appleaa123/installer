import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { agentOf, CHECK_TTL_MS, type CheckContext } from "./check-commands.js";
import { checkFolder, connectedSheet } from "./check-reads.js";
import { loadChallenge, openChallenge, recordResult, saveChallenge, settleChallenge, startChallenge, type Challenge, type Need, type StoredResult } from "./checks.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * T3, writing (spec 5.2, item 7a). The word is in the instruction (it proves writing, not secrecy), so what counts is
 * what TaskFollow reads back itself from a target it made: a file in its own check folder, or a tab it added. A word
 * the agent only sends back never settles it. Any other target (the person's CRM, a task app) is never a test: writes
 * there go through approve-agent-call (D151, PR #40) or stay draft-only. Writing never decides a home.
 */
type Raw = Record<string, unknown>;
export const READ_BACK_TESTS: readonly string[] = ["t3f", "t3r"];
const OTHER_TARGET = "Not checked: TaskFollow only tests writing into a file or sheet tab it made itself. Writes into your own tools (a CRM, a task app) go through approve-agent-call (D151, still pending) or stay draft-only";
const done = (id: string): string => `Then run: taskfollow check answer ${id} done`;

async function begin(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext, test: string, need: Need): Promise<{ challenge: Challenge; word: string } | Raw> {
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
  if (typeof flags.value === "string" && /"target"/.test(flags.value)) {
    await recordResult(home, { need, ...(workflow ? { workflow } : {}), result: "not-checked", reason: OTHER_TARGET, at: context.now(), agent, agent_version: version, test });
    return { need, result: "not checked", why: OTHER_TARGET };
  }
  const { challenge, word } = await startChallenge(home, { needs: [need], test, ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  return { challenge, word: word ?? "" };
}

export async function startWritesFiles(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const begun = await begin(home, state, flags, context, "t3f", "writes:files");
  if (!("challenge" in begun)) return begun;
  const { challenge, word } = begun as { challenge: Challenge; word: string };
  const file = join(await checkFolder(home, state), `${randomBytes(6).toString("hex")}.txt`);
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), file } });
  return { id: challenge.id, test: "t3f", instruction: `Write this word, and nothing else, into the file ${file} (create it): ${word}. ${done(challenge.id)}` };
}

export async function startWritesRecords(home: string, state: InstallState | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const target = await (context.sheets ?? connectedSheet)(home);
  if (!target?.client.addTab) {
    // Review 8 of PR #54: recorded like the reads variant, so the summary and the report show it.
    const why = "Not checked: TaskFollow can only test writing into a sheet tab it made, through its own Google Sheets connection, and none is connected";
    const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
    const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
    await recordResult(home, { need: "writes:records", ...(workflow ? { workflow } : {}), result: "not-checked", reason: why, at: context.now(), agent, agent_version: version, test: "t3r" });
    return { need: "writes:records", result: "not checked", why };
  }
  const begun = await begin(home, state, flags, context, "t3r", "writes:records");
  if (!("challenge" in begun)) return begun;
  const { challenge, word } = begun as { challenge: Challenge; word: string };
  const tab = `taskfollow-check-${challenge.id}`;
  const sheetId = await target.client.addTab(target.spreadsheet_id, tab);
  await saveChallenge(home, { ...challenge, details: { ...(challenge.details ?? {}), tab, tab_id: String(sheetId), spreadsheet: target.spreadsheet_id } });
  return { id: challenge.id, test: "t3r", instruction: `Write this word, and nothing else, into cell A1 of the tab "${tab}" in the spreadsheet TaskFollow uses (id ${target.spreadsheet_id}): ${word}. ${done(challenge.id)}` };
}

/** What the target holds now, read by TaskFollow itself; empty when it cannot be read. */
async function readBack(home: string, challenge: Challenge, context: CheckContext): Promise<string> {
  const details = challenge.details ?? {};
  if (challenge.test === "t3f" && details.file && basename(dirname(details.file)) === "taskfollow-check") return readFile(details.file, "utf8").then((text) => text.trim(), () => "");
  if (challenge.test === "t3r" && details.tab?.startsWith("taskfollow-check-") && details.spreadsheet) {
    const target = await (context.sheets ?? connectedSheet)(home);
    if (!target || target.spreadsheet_id !== details.spreadsheet) return "";
    return (await target.client.readRows({ spreadsheet_id: details.spreadsheet, tab: details.tab }))[0]?.[0]?.trim() ?? "";
  }
  return "";
}

/** `check answer <id> done` for a writing test: TaskFollow reads the target and settles on what it found there. */
export async function answerByReadBack(home: string, id: string, context: CheckContext): Promise<StoredResult> {
  const challenge = await openChallenge(home, id, context.now());
  return settleChallenge(home, challenge, await readBack(home, challenge, context), "agent", context.now(), undefined, "read-back");
}

export const isReadBack = async (home: string, id: string): Promise<boolean> => READ_BACK_TESTS.includes((await loadChallenge(home, id))?.test ?? "");
