import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { listOutbox } from "./outbound.js";
import { loadPinnedSolution } from "./pin.js";
import { startRun } from "./runner.js";
import { listInbox } from "./inbox.js";
import { listSteps, loadRun, loadStep, type RunTrigger } from "./runs.js";
import { loadState } from "./state.js";
import type { StepWhen } from "./types.js";
import { whenHolds } from "./visibility.js";
import { loadSandboxMode, loadWorkflowState, saveWorkflowState, setSandboxMode, type DrySample, type WorkflowState } from "./sandbox.js";
import { HEARTBEAT_FILE, wants } from "./tick.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { rm, rmdir } from "node:fs/promises";
import { SHAPES, workflowHash } from "./homes.js";
import { notesFolder, prepareNotesFolder } from "./task-files.js";
import { restoreFile } from "./agent-file.js";
import { checkLocalSkills, HOME_FOLDER_NOTE, isSkillswikiRef, type SkillRoots } from "./skills.js";
import { agentFileBefore, installTargets, loadWritten, plannedSkillFolder, refreshAgentFile, saveWritten, shippedSkill, writeWorkflowSkill } from "./workflow-skill.js";
import { MAX_WORKFLOW_SKILLS, WORKFLOWS_DIR, WORKFLOW_FILE, loadWorkflow, parseWorkflow, requireWorkflowId, workflowIds, type Workflow } from "./workflow.js";

/**
 * Install phases 5–7 (spec §6.2, §10.8, §16.2, D98). WORKFLOWS: a workflow v1 comes from a recipe suggestion
 * (`taskfollow workflow add <id>`) or from the person's plain words (`--value '{"description","tools"}'`, an agentic
 * v1). Every new workflow starts in sandbox. DRY RUN: `taskfollow dryrun` runs each one in sandbox and shows what it
 * would have done (the recorded messages and actions); the person reads it and confirms in their own terminal
 * (`taskfollow dryrun confirm <id>`), which takes that workflow out of sandbox. ACTIVATE leaves the engine's sandbox
 * mode once every workflow is confirmed, starts the gateway, and asks the person to load the schedule.
 */
export const RUNNER_ALIVE_MS = 5 * 60 * 1000;
const PLAIN_WORDS = '--value \'{"description":"<what to do, in the person\'s words>","tools":["<tool>",…],"trigger":{"cron":"0 8 * * 1-5","tz":"<IANA zone>"}}\'';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** The recipe's suggestions that fit what the person chose: one with a `when` shows only once that choice was made (D131). */
async function suggestions(home: string): Promise<readonly Raw[]> {
  const offered = (await loadPinnedSolution(home)).solution.workflows ?? [];
  const state = await loadState(home);
  return offered.filter((entry) => entry.when === undefined || (state !== null && whenHolds(entry.when as StepWhen, state)));
}

/** D171: what the person hears when a workflow reads meeting-notes/ but the install folder is not known. */
const NO_NOTES_FOLDER = "TaskFollow does not know which folder this install was started from, so it made no meeting-notes/ folder; paste the notes in the chat instead";

/** What a person may give with a suggested workflow (item 5): their time, their skills, rules and examples. */
const SUGGESTION_KEYS = ["trigger", "skills", "my_rules", "examples"];

/** A suggestion may say `"tz": "local"`: it runs in this computer's own time zone, which only the computer knows (D130). */
function withLocalZone(raw: Raw): Raw {
  const trigger = raw.trigger;
  if (!isRecord(trigger) || trigger.tz !== "local") return raw;
  return { ...raw, trigger: { ...trigger, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } };
}

/** The skills the person confirmed (9.12 item 2): at most 9, so the workflow's own skill folder fits in front of them. */
export const MAX_OWNER_SKILLS = MAX_WORKFLOW_SKILLS - 1;

function ownerSkills(words: Raw): Raw {
  if (words.skills === undefined) return {};
  if (Array.isArray(words.skills) && words.skills.length > MAX_OWNER_SKILLS) throw new InputError(`workflow add: "skills" may name at most ${MAX_OWNER_SKILLS} skills; the workflow's own skill takes the tenth place`);
  return Array.isArray(words.skills) && words.skills.length === 0 ? {} : { skills: words.skills };
}

function parseWords(value: string): Raw {
  let words: unknown;
  try {
    words = JSON.parse(value);
  } catch {
    throw new InputError(`workflow add: --value must be JSON, ${PLAIN_WORDS}`);
  }
  if (!isRecord(words)) throw new InputError(`workflow add needs the person's description: ${PLAIN_WORDS}`);
  return words;
}

/**
 * A suggestion by id (with the skills the person confirmed, when `--value` carries no description), or the person's
 * description turned into an agentic v1 (§10.8: describe → v1 agentic).
 */
function newWorkflow(id: string, value: string | undefined, suggested: readonly Raw[]): Raw {
  const words = value === undefined ? undefined : parseWords(value);
  const found = suggested.find((entry) => entry.workflow === id);
  if (words === undefined || (words.description === undefined && found)) {
    if (!found) throw new InputError(`No suggested workflow '${id}' (${suggested.map((entry) => String(entry.workflow)).join(", ") || "the recipe suggests none"}); describe a new one with ${PLAIN_WORDS}`);
    const { when: _when, ...suggestion } = found;
    // Item 5: the person may give their own time; anything else would change the suggestion's shape (D159).
    const other = Object.keys(words ?? {}).filter((key) => !SUGGESTION_KEYS.includes(key));
    if (other.length > 0) throw new InputError(`workflow add: a suggested workflow's --value may change only ${SUGGESTION_KEYS.join(", ")} (not ${other.join(", ")}); to change more, describe your own workflow with ${PLAIN_WORDS}`);
    const timed = words?.trigger === undefined ? suggestion : { ...suggestion, trigger: words.trigger };
    return { ...withLocalZone(timed), version: 1, ...(words ? ownerSkills(words) : {}) };
  }
  if (typeof words.description !== "string" || words.description.trim() === "") throw new InputError(`workflow add needs the person's description: ${PLAIN_WORDS}`);
  const { description, tools, trigger, max_turns: turns, steps } = words;
  const skills = ownerSkills(words);
  // D142: fixed steps the agent wrote with the person (for example a task step that uses the person's own tools).
  if (steps !== undefined) return withLocalZone({ workflow: id, version: 1, mode: "typed", description, ...(trigger === undefined ? {} : { trigger }), steps, ...skills });
  return { workflow: id, version: 1, mode: "agentic", description, instructions: description, tools, ...(trigger === undefined ? {} : { trigger }), ...(turns === undefined ? {} : { max_turns: turns }), ...skills };
}

/** What the person must hear when the workflow's own skill cannot be written (9.7: say every gap clearly). */
function noFolderNote(profile: { name: string; skills_dirs?: { project?: string } } | undefined, roots: SkillRoots, workDirKnown: boolean): string {
  if (roots.home_folder) return HOME_FOLDER_NOTE;
  if (!workDirKnown && profile?.skills_dirs?.project) return "TaskFollow does not know which folder this install was started from, so the workflow's own skill and the CLAUDE.md section are not written; tell the person";
  return `${profile?.name ?? "This agent"} has no skills folder TaskFollow knows, so this workflow's own rules have nowhere to live yet; tell the person`;
}

async function addWorkflow(home: string, id: string, value: string | undefined, now: string): Promise<Record<string, unknown>> {
  if ((await workflowIds(home)).includes(id)) throw new InputError(`Workflow '${id}' exists already; a change to it is a new version (taskfollow harden), never an overwrite`);
  const raw = newWorkflow(id, value, await suggestions(home));
  const rules = value === undefined ? undefined : parseWords(value).my_rules;
  if (rules !== undefined && typeof rules !== "string") throw new InputError('workflow add: "my_rules" must be text, the person\'s own rules from the interview');
  const examples = value === undefined ? undefined : parseWords(value).examples;
  if (examples !== undefined && typeof examples !== "string") throw new InputError('workflow add: "examples" must be text, two or three of the person\'s real past items with what they expect');
  const owner = parseWorkflow(raw, id, DEFAULT_TOOLS);
  // D126 changed (9.12 item 2): only a skillswiki: reference needs a Skills Wiki connection; a local skill does not.
  const needsSkill = owner.steps.some((step) => step.kind === "judge" && step.judge.skill !== undefined) || owner.skills.some(isSkillswikiRef);
  if (needsSkill && !(await loadState(home))?.skillswiki) throw new InputError("This workflow uses a Skills Wiki skill. Connect Skills Wiki first (INSTALL.md, section 11) or choose another workflow.");
  const { profile, roots, agentFile } = await installTargets(home);
  const workDir = (await loadState(home))?.work_dir;
  const workDirKnown = workDir !== undefined;
  // D171: a workflow that reads meeting-notes/ gets that folder; a link or a file there is refused before anything is written.
  const readsNotes = owner.steps.some((step) => step.kind === "task" && step.task.read_from === "meeting-notes");
  if (readsNotes && workDir !== undefined) await notesFolder(workDir);
  await checkLocalSkills(owner.skills.filter((ref) => !isSkillswikiRef(ref)), roots);
  // Everything that can refuse does so before anything is written (H4): the folder name and the agent file's section.
  const folder = await plannedSkillFolder(roots, id);
  if (folder === null && rules !== undefined) throw new InputError(noFolderNote(profile, roots, workDirKnown));
  const final = folder === null ? raw : { ...raw, skills: [folder, ...owner.skills] };
  // D159: a suggestion's shape lives in the workflow state with the file's hash, never in the file the agent writes.
  const fromSuggestion = (await suggestions(home)).some((entry) => entry.workflow === id) && (value === undefined || parseWords(value).description === undefined);
  const workflow = parseWorkflow(final, id, DEFAULT_TOOLS);
  const before = await agentFileBefore(agentFile);
  const writtenBefore = await loadWritten(home);
  let notes: { readonly path: string; readonly created: boolean } | null = null;
  try {
    // Item 5: a suggestion that is one of the shapes gets the skill TaskFollow ships for it; anything else the generic one.
    const shipped = fromSuggestion && Object.hasOwn(SHAPES, id) ? await shippedSkill(id) : null;
    if (folder) await writeWorkflowSkill(folder, id, workflow.description, rules, { shipped, ...(examples === undefined ? {} : { examples }) });
    await refreshAgentFile(home, { workflow: id, description: workflow.description, skills: workflow.skills });
    await writeConfig(home, join(WORKFLOWS_DIR, id, WORKFLOW_FILE), final);
    await saveWorkflowState(home, { workflow: id, sandbox: true, ...(fromSuggestion ? { shape: id, content_hash: workflowHash(final) } : {}) });
    const written = await loadWritten(home);
    if (folder && roots.project) await saveWritten(home, { ...written, skill_folders: [...written.skill_folders, { workflow: id, path: folder, root: roots.project }] });
    if (readsNotes && workDir !== undefined) {
      notes = await prepareNotesFolder(workDir);
      const current = await loadWritten(home);
      if (!current.notes_folder) await saveWritten(home, { ...current, notes_folder: notes });
    }
  } catch (error) {
    if (folder) await rm(folder, { recursive: true, force: true });
    if (notes?.created) await rmdir(notes.path).catch(() => undefined);
    if (agentFile) await restoreFile(agentFile, before).catch(() => undefined);
    await rm(join(home, WORKFLOWS_DIR, id), { recursive: true, force: true }).catch(() => undefined);
    await saveWritten(home, writtenBefore).catch(() => undefined);
    if (error instanceof InputError || error instanceof ActionFailure) throw error;
    throw new ActionFailure(`TaskFollow could not write the workflow's files (${folder ?? join(home, WORKFLOWS_DIR, id)}): ${(error as Error).message}. Nothing was added; check that the folder can be written, then try again`);
  }
  const note = folder === null ? { note: noFolderNote(profile, roots, workDirKnown) } : {};
  const notesNote = readsNotes && workDir === undefined ? { notes: NO_NOTES_FOLDER } : notes ? { notes_folder: notes.path } : {};
  await appendAudit(home, { ts: now, actor: "agent", event: "workflow.added", ref: `workflow:${id}`, payload: { mode: workflow.mode, from: value === undefined ? "suggestion" : "description", skills: workflow.skills, skill_folder: folder, agent_file: agentFile } });
  return { status: "added", workflow: id, version: 1, mode: workflow.mode, sandbox: true, skills: workflow.skills, skill_folder: folder, agent_file: agentFile, ...note, ...notesNote, next: `Run 'taskfollow dryrun ${id}' and show the person what it would do` };
}

async function describeAll(home: string): Promise<Record<string, unknown>[]> {
  const rows = [];
  for (const id of await workflowIds(home)) {
    try {
      const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
      const state = await loadWorkflowState(home, id);
      rows.push({ workflow: id, version: workflow.version, mode: workflow.mode, trigger: workflow.trigger, sandbox: state?.sandbox ?? false, dry_run: state?.dry_run ?? null, skills: workflow.skills });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      rows.push({ workflow: id, error: error.message });
    }
  }
  return rows;
}

/** `taskfollow workflow list | suggestions | add <id> [--value <plain words>]`. */
export async function workflowCommand(home: string, sub: string | undefined, id: string | undefined, value: string | undefined, now: () => string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "list") return { workflows: await describeAll(home) };
  if (sub === "suggestions") return { suggestions: (await suggestions(home)).map((entry) => ({ workflow: entry.workflow, description: entry.description ?? "", mode: entry.mode ?? "typed", trigger: entry.trigger ?? { manual: true } })) };
  if (sub === "add") return addWorkflow(home, requireWorkflowId(id), value, now());
  throw new InputError("workflow takes: list, suggestions, add <id> [--value <json>]");
}

/**
 * The message an event-triggered workflow's dry run is given (D88): the latest stored one its trigger matches, else
 * the person's sample from `--value`, bound with `synthetic: true` (and untrusted, like every message).
 */
async function sampleFor(home: string, workflow: Workflow, value: string | undefined): Promise<{ trigger: RunTrigger; sample?: DrySample }> {
  if (workflow.trigger.kind !== "event") return { trigger: { kind: "manual" } };
  const stored = (await listInbox(home)).find((item) => wants(workflow, item));
  if (stored) return { trigger: { kind: "manual", inbox_id: stored.id }, sample: { inbox_id: stored.id } };
  let sample: unknown;
  try {
    sample = value === undefined ? undefined : JSON.parse(value);
  } catch {
    sample = undefined;
  }
  if (!isRecord(sample)) throw new InputError(`Workflow '${workflow.id}' starts on a message and no stored message matches its trigger yet: give it a sample with 'taskfollow dryrun ${workflow.id} --value '<sample event json>'', for example '{"channel":"telegram","from":"sample","text":"<a message it should handle>"}'`);
  return { trigger: { kind: "manual", sample_event: { ...sample, untrusted: true, synthetic: true } }, sample: { synthetic: sample } };
}

/** One sandbox run of the current version, and what it would have done. */
async function dryRun(home: string, workflow: Workflow, now: () => string, value: string | undefined): Promise<Record<string, unknown>> {
  const { trigger, sample } = await sampleFor(home, workflow, value);
  const record = await startRun({ home, workflow, key: `${workflow.id}:dryrun:${workflow.version}:${now()}`, trigger, now, sandbox: true });
  const state: WorkflowState = { ...((await loadWorkflowState(home, workflow.id)) ?? { workflow: workflow.id, sandbox: true }), dry_run: { version: workflow.version, run_id: record.run_id, status: record.status, ...(sample ? { sample } : {}) } };
  await saveWorkflowState(home, state);
  const steps = [];
  for (const step of workflow.steps) {
    const log = await loadStep(home, record, step.id);
    steps.push({ step: step.id, status: log?.status ?? "not_run", output: log?.output ?? null, ...(log?.error ? { error: log.error } : {}), ...(log?.turns ? { calls: log.turns.length } : {}) });
  }
  const would = await listOutbox(home, `${workflow.id}/${record.run_id}`);
  return { workflow: workflow.id, version: workflow.version, run_id: record.run_id, status: record.status, ...(record.reason ? { reason: record.reason } : {}), ...(sample ? { sample } : {}), steps, would_have: would, note: "Nothing was sent or changed: these are recordings (sandbox). Show them to the person." };
}

async function confirm(home: string, id: string, by: string, now: string): Promise<Record<string, unknown>> {
  const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
  const state = await loadWorkflowState(home, id);
  const run = state?.dry_run;
  if (!run || run.version !== workflow.version) throw new InputError(`Workflow '${id}' has no dry run of version ${workflow.version} yet: run 'taskfollow dryrun ${id}' first`);
  if (run.status === "failed") throw new InputError(`The last dry run of '${id}' failed; fix it and run 'taskfollow dryrun ${id}' again`);
  // Review of PR #61: a dry run that stopped early (no file to read, D171) or ran no step showed nothing to confirm.
  const record = await loadRun(home, id, run.run_id);
  if (record?.reason) throw new InputError(`The last dry run of '${id}' ended early: ${record.reason} Then run 'taskfollow dryrun ${id}' again`);
  if (record && !(await listSteps(home, record)).some((log) => log.status === "done" && !log.skipped)) {
    throw new InputError(`The last dry run of '${id}' ran no step, so there is nothing to confirm yet; run 'taskfollow dryrun ${id}' again when it has something to do`);
  }
  await saveWorkflowState(home, { ...state, workflow: id, sandbox: false, dry_run: { ...run, confirmed_by: by, confirmed_at: now } });
  await appendAudit(home, { ts: now, actor: "human", event: "workflow.dry_run_confirmed", ref: `workflow:${id}`, payload: { by, version: run.version, run_id: run.run_id } });
  return { status: "confirmed", workflow: id, version: run.version, run_id: run.run_id };
}

/**
 * `taskfollow dryrun [<id> [--value <sample event json>]] | confirm <id>`: confirming is the person's own reading of the
 * output, in their terminal.
 */
export async function dryrunCommand(home: string, sub: string | undefined, id: string | undefined, person: { interactive: boolean; as?: string }, now: () => string, value?: string): Promise<Record<string, unknown>> {
  if (sub === "confirm") {
    if (!person.interactive) throw new InputError("A dry run is confirmed by the person who read it, in their own terminal: 'taskfollow dryrun confirm <workflow>'");
    return confirm(home, requireWorkflowId(id), person.as?.trim() || "terminal", now());
  }
  const ids = sub === undefined ? await workflowIds(home) : [requireWorkflowId(sub)];
  if (ids.length === 0) throw new InputError("No workflows yet: add one with 'taskfollow workflow add <id>'");
  const runs = [];
  for (const workflowId of ids) runs.push(await dryRun(home, await loadWorkflow(home, workflowId, DEFAULT_TOOLS), now, value));
  return { dry_runs: runs };
}
/** `taskfollow sandbox [status | on | off | outbox]`: `off` sends real messages again, so only a person runs it, in a terminal. */
export async function sandboxCommand(home: string, sub: string | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "status") return { mode: (await loadSandboxMode(home)) ?? { on: false }, workflows: (await describeAll(home)).map(({ workflow, sandbox }) => ({ workflow, sandbox })) };
  if (sub === "outbox") return { outbox: await listOutbox(home) };
  if (sub === "on") return { status: "on", mode: await setSandboxMode(home, true, person.interactive ? person.as?.trim() || "terminal" : "agent", now()) };
  if (sub !== "off") throw new InputError("sandbox takes: status, on, off, outbox");
  if (!person.interactive) throw new InputError("Leaving sandbox sends real messages again: the person runs 'taskfollow sandbox off' in their own terminal");
  return { status: "off", mode: await setSandboxMode(home, false, person.as?.trim() || "terminal", now()) };
}

/** For the phase checks: each workflow and whether its current version was dry-run, and confirmed. */
export async function lifecycleStatus(home: string): Promise<{ id: string; ran: boolean; confirmed: boolean }[]> {
  const rows = [];
  for (const id of await workflowIds(home)) {
    const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
    const run = (await loadWorkflowState(home, id))?.dry_run;
    const ran = run !== undefined && run.version === workflow.version && run.status !== "failed";
    rows.push({ id, ran, confirmed: ran && run?.confirmed_at !== undefined });
  }
  return rows;
}

/** The runner ticked within the last five minutes: the OS scheduler entry is loaded (D82). */
export async function runnerTicking(home: string, now: string): Promise<boolean> {
  const last = ((await readConfig(home, HEARTBEAT_FILE)) as { last?: string } | null)?.last;
  return last !== undefined && Date.parse(now) - Date.parse(last) <= RUNNER_ALIVE_MS;
}
