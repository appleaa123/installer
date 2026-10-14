import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { runTask } from "./agent-task.js";
import { interpolate, type Scope } from "./expressions.js";
import { ActionFailure } from "./failure.js";
import { validateSchema } from "./json-schema.js";
import { protectedFields, stripFields } from "./judge.js";
import { loadProfileById } from "./profile.js";
import { auditRun, fingerprint, RUNS_DIR, saveStep, type RunRecord } from "./runs.js";
import type { Exec, StepOutcome } from "./runner-steps.js";
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

async function seal(exec: Exec, record: RunRecord, step: string, path: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return;
  }
  const lines = text.split("\n").filter((line) => line !== "").length;
  await auditRun(exec.home, exec.ctx.now(), "run.task_calls", record, { step, file: callsFile(record, step), lines, sha256: createHash("sha256").update(text).digest("hex") });
}

async function profileFor(exec: Exec) {
  const id = exec.state?.runtime?.profile;
  if (!id) throw new ActionFailure("No agent was found on this computer ('taskfollow probe'), so a task step cannot run");
  const profile = await loadProfileById(id);
  if (!profile.task) throw new ActionFailure(`${profile.name} cannot run task steps yet: TaskFollow has not checked how to limit and record its tools`);
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

export async function runTaskStep(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "task" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const spec = step.task;
  if (record.sandbox && spec.changes) {
    await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(null), output: null, skipped: true });
    return { kind: "done", output: null, actions: 0, needs_human: 0 };
  }
  const profile = await profileFor(exec);
  const input = stripFields(spec.input === undefined ? null : interpolate(spec.input, scope), protectedFields(exec.contract));
  const path = await confinedPath(exec.home, callsFile(record, step.id));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await saveStep(exec.home, record, { step: step.id, status: "failed", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(input), error: TASK_INTERRUPTED });
  const result = await runTask(exec.home, profile, { prompt: spec.prompt, input, may_use: spec.may_use, changes: spec.changes, output: spec.output, timeoutMs: spec.timeout_minutes * MINUTE_MS, record: path }, {
    env: { ...(exec.env ?? process.env) },
  });
  await seal(exec, record, step.id, path);
  if (!result.ok) throw new ActionFailure(`The agent did not finish the task: ${result.error}`);
  const output = answerOf(result.structured, result.text);
  const problems = validateSchema(spec.output, output);
  if (problems.length > 0) throw new ActionFailure(`The agent's answer does not fit the step's output: ${problems.join("; ")}`);
  const finished = exec.ctx.now();
  await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(startedAt)), input_fingerprint: fingerprint(input), output });
  return { kind: "done", output, actions: spec.changes ? 1 : 0, needs_human: 0 };
}
