import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { listOutbox } from "./outbound.js";
import { loadPinnedSolution } from "./pin.js";
import { startRun } from "./runner.js";
import { listInbox } from "./inbox.js";
import { loadStep, type RunTrigger } from "./runs.js";
import { loadState } from "./state.js";
import type { StepWhen } from "./types.js";
import { whenHolds } from "./visibility.js";
import { loadSandboxMode, loadWorkflowState, saveWorkflowState, setSandboxMode, type DrySample, type WorkflowState } from "./sandbox.js";
import { HEARTBEAT_FILE, wants } from "./tick.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { WORKFLOWS_DIR, WORKFLOW_FILE, loadWorkflow, parseWorkflow, requireWorkflowId, workflowIds, type Workflow } from "./workflow.js";

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

/** A suggestion may say `"tz": "local"`: it runs in this computer's own time zone, which only the computer knows (D130). */
function withLocalZone(raw: Raw): Raw {
  const trigger = raw.trigger;
  if (!isRecord(trigger) || trigger.tz !== "local") return raw;
  return { ...raw, trigger: { ...trigger, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } };
}

/** A suggestion by id, or the person's description turned into an agentic v1 (§10.8: describe → v1 agentic). */
function newWorkflow(id: string, value: string | undefined, suggested: readonly Raw[]): Raw {
  if (value === undefined) {
    const found = suggested.find((entry) => entry.workflow === id);
    if (!found) throw new InputError(`No suggested workflow '${id}' (${suggested.map((entry) => String(entry.workflow)).join(", ") || "the recipe suggests none"}); describe a new one with ${PLAIN_WORDS}`);
    const { when: _when, ...suggestion } = found;
    return { ...withLocalZone(suggestion), version: 1 };
  }
  let words: unknown;
  try {
    words = JSON.parse(value);
  } catch {
    throw new InputError(`workflow add: --value must be JSON, ${PLAIN_WORDS}`);
  }
  if (!isRecord(words) || typeof words.description !== "string" || words.description.trim() === "") throw new InputError(`workflow add needs the person's description: ${PLAIN_WORDS}`);
  const { description, tools, trigger, max_turns: turns, steps } = words;
  // D142: fixed steps the agent wrote with the person (for example a task step that uses the person's own tools).
  if (steps !== undefined) return withLocalZone({ workflow: id, version: 1, mode: "typed", description, ...(trigger === undefined ? {} : { trigger }), steps });
  return { workflow: id, version: 1, mode: "agentic", description, instructions: description, tools, ...(trigger === undefined ? {} : { trigger }), ...(turns === undefined ? {} : { max_turns: turns }) };
}

async function addWorkflow(home: string, id: string, value: string | undefined, now: string): Promise<Record<string, unknown>> {
  if ((await workflowIds(home)).includes(id)) throw new InputError(`Workflow '${id}' exists already; a change to it is a new version (taskfollow harden), never an overwrite`);
  const raw = newWorkflow(id, value, await suggestions(home));
  const workflow = parseWorkflow(raw, id, DEFAULT_TOOLS);
  const needsSkill = workflow.steps.some((step) => step.kind === "judge" && step.judge.skill !== undefined);
  if (needsSkill && !(await loadState(home))?.skillswiki) throw new InputError("This workflow uses a Skills Wiki skill. Connect Skills Wiki first (INSTALL.md, section 11) or choose another workflow.");
  await writeConfig(home, join(WORKFLOWS_DIR, id, WORKFLOW_FILE), raw);
  await saveWorkflowState(home, { workflow: id, sandbox: true });
  await appendAudit(home, { ts: now, actor: "agent", event: "workflow.added", ref: `workflow:${id}`, payload: { mode: workflow.mode, from: value === undefined ? "suggestion" : "description" } });
  return { status: "added", workflow: id, version: 1, mode: workflow.mode, sandbox: true, next: `Run 'taskfollow dryrun ${id}' and show the person what it would do` };
}

async function describeAll(home: string): Promise<Record<string, unknown>[]> {
  const rows = [];
  for (const id of await workflowIds(home)) {
    try {
      const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
      const state = await loadWorkflowState(home, id);
      rows.push({ workflow: id, version: workflow.version, mode: workflow.mode, trigger: workflow.trigger, sandbox: state?.sandbox ?? false, dry_run: state?.dry_run ?? null });
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
  await saveWorkflowState(home, { workflow: id, sandbox: false, dry_run: { ...run, confirmed_by: by, confirmed_at: now } });
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
