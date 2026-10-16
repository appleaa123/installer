import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { runTask } from "./agent-task.js";
import { interpolate, type Scope } from "./expressions.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { validateSchema } from "./json-schema.js";
import { protectedFields, stripFields } from "./judge.js";
import { loadProfileById, versionAtLeast } from "./profile.js";
import { noteRunPassed } from "./check-fresh.js";
import { auditRun, fingerprint, RUNS_DIR, saveStep, type RunRecord } from "./runs.js";
import type { Exec, StepOutcome } from "./runner-steps.js";
import { chooseAttachments, chooseNote, NO_ATTACHMENT, NO_NOTE, type ChosenFile, type ReadFrom } from "./task-files.js";
import type { WorkflowStep } from "./workflow.js";

/**
 * Runs a task step (D139). Before the agent starts, the step is marked as started, so a crash in the middle is never
 * run again by itself: the agent may already have acted (the runner stops the run instead). The hook writes each
 * call to `runs/<workflow>/<run>/<step>.calls.jsonl`; when the agent is done the file's hash goes into the audit, so
 * the record is tamper-evident from then on. A dry run runs a read-only task (the hook refuses writes) but never a
 * task that may change things. The agent's answer must fit the step's output schema.
 */
export const TASK_INTERRUPTED = "the task started but the run stopped before it finished";
const MINUTE_MS = 60_000;

export const callsFile = (record: RunRecord, step: string): string => join(RUNS_DIR, record.workflow, record.run_id, `${step}.calls.jsonl`);

export async function seal(exec: Exec, record: RunRecord, step: string, path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((line) => line !== "").length;
  await auditRun(exec.home, exec.ctx.now(), "run.task_calls", record, { step, file: callsFile(record, step), lines, sha256: createHash("sha256").update(text).digest("hex") });
}

export async function profileFor(exec: Exec) {
  const id = exec.state?.runtime?.profile;
  if (!id) throw new ActionFailure("No agent was found on this computer ('taskfollow probe'), so a task step cannot run");
  const profile = await loadProfileById(id);
  if (!profile.task) throw new ActionFailure(`${profile.name} cannot run task steps yet: TaskFollow has not checked how to limit and record its tools`);
  const version = exec.state?.runtime?.agent_version ?? null;
  const needed = profile.task.min_version ?? profile.min_version;
  if (version === null || !versionAtLeast(version, needed)) {
    throw new ActionFailure(`${profile.name} ${version ?? "(unknown version)"} is older than ${needed}, which task steps need for their checks: update it, then run 'taskfollow probe'`);
  }
  return profile;
}

function answerOf(structured: unknown, text: string): unknown {
  if (structured !== undefined) return structured;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ActionFailure("The agent did not answer with JSON");
  }
}

/** Whether the task's call record shows a call to TaskFollow's own tools that went through. */
async function reachedOwnTools(path: string): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").some((line) => {
    try {
      const entry = JSON.parse(line) as { tool?: unknown; outcome?: unknown; reason_for?: unknown };
      const through = entry.outcome === "ok" || (entry.reason_for !== undefined && entry.outcome === undefined);
      return typeof entry.tool === "string" && entry.tool.startsWith("mcp__installer__") && through;
    } catch {
      return false;
    }
  });
}

/** D171: the files the runner chose for this step; the model never names a path. */
async function chosenFiles(exec: Exec, readFrom: ReadFrom, input: unknown): Promise<readonly ChosenFile[]> {
  if (readFrom === "attachments") return chooseAttachments(exec.home, input);
  const workDir = exec.state?.work_dir;
  if (!workDir) throw new ActionFailure("TaskFollow does not know which folder this install was started from, so it cannot read meeting-notes/; paste the notes in the chat instead");
  try {
    const note = await chooseNote(workDir);
    return note === null ? [] : [note];
  } catch (error) {
    if (error instanceof InputError) throw new ActionFailure(error.message);
    throw error;
  }
}

export async function runTaskStep(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "task" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const spec = step.task;
  if (record.sandbox && spec.changes) {
    await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(null), output: null, skipped: true });
    return { kind: "done", output: null, actions: 0, needs_human: 0 };
  }
  const interpolated = spec.input === undefined ? null : interpolate(spec.input, scope);
  const files = spec.read_from === undefined ? undefined : await chosenFiles(exec, spec.read_from, interpolated);
  if (files !== undefined && files.length === 0) {
    // D171: no usable file, no agent run: the run ends with a plain message and nothing is spent.
    await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(null), output: null, skipped: true });
    return { kind: "stop", status: "completed", reason: spec.read_from === "attachments" ? NO_ATTACHMENT : NO_NOTE };
  }
  const profile = await profileFor(exec);
  const stripped = stripFields(interpolated, protectedFields(exec.contract));
  const input = files === undefined ? stripped : { ...(typeof stripped === "object" && stripped !== null && !Array.isArray(stripped) ? stripped : { input: stripped }), files };
  const path = await confinedPath(exec.home, callsFile(record, step.id));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await saveStep(exec.home, record, { step: step.id, status: "failed", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(input), error: TASK_INTERRUPTED });
  const skills = await exec.skills();
  const result = await runTask(exec.home, profile, { prompt: spec.prompt, input, may_use: spec.may_use, changes: spec.changes, output: spec.output, timeoutMs: spec.timeout_minutes * MINUTE_MS, record: path, skills, ...(files ? { files: files.map((file) => file.path) } : {}) }, {
    env: { ...(exec.env ?? process.env) },
  });
  await seal(exec, record, step.id, path);
  if (!result.ok) throw new ActionFailure(`The agent did not finish the task: ${result.error}`);
  const output = answerOf(result.structured, result.text);
  const problems = validateSchema(spec.output, output);
  if (problems.length > 0) throw new ActionFailure(`The agent's answer does not fit the step's output: ${problems.join("; ")}`);
  const finished = exec.ctx.now();
  await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(startedAt)), input_fingerprint: fingerprint(input), output });
  // Review 4 of PR #54: a real run that finished under the hook proves the runner again (and TaskFollow's tools, when reached).
  if (!record.sandbox) await noteRunPassed(exec.home, record.workflow, exec.state, finished, await reachedOwnTools(path));
  return { kind: "done", output, actions: spec.changes ? 1 : 0, needs_human: 0 };
}
