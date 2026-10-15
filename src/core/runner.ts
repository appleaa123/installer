import { continueAgent, resumeAgent, type AgentRun } from "./agentic.js";
import { ToolRefusal, getApproval } from "./approvals.js";
import { holds, interpolate, type Scope } from "./expressions.js";
import { ActionFailure } from "./failure.js";
import { listInbox } from "./inbox.js";
import { InputError } from "./inputs.js";
import type { JudgeBackend } from "./judge.js";
import { judgeBackend } from "./model.js";
import { loadPinnedContract } from "./pin.js";
import { checkApproval, runApprove, runCalc, runJudge, runTool, type Exec, type StepOutcome } from "./runner-steps.js";
import { FINISHED, auditRun, claimRun, fingerprint, loadStep, previousOutputs, runForKey, runIdFor, saveRun, saveStep, type RunRecord, type RunTrigger } from "./runs.js";
import { PAUSED_REASON, isPaused } from "./pause.js";
import { runsInSandbox } from "./sandbox.js";
import { TASK_INTERRUPTED, runTaskStep } from "./task-step.js";
import { loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { invokeTool, toolContext } from "./tools.js";
import { FALLBACK_STEP, type AgentSpec, type Workflow, type WorkflowStep } from "./workflow.js";

/**
 * The workflow runner (spec §10, D81, D86, D87). A run is claimed by its idempotency key, then its steps run in
 * order; a step whose log says done is not run again, so a run that waited for an approval, crashed or was
 * stopped resumes from its last completed step (§10.7). Escalation (§10.9, D18): answers that need a person,
 * a run that fails (drift: a typed step met input or an API it did not expect) and an approval that expired are
 * told to the decision maker with `channel.notify` (internal, L1, through the gate and the R6 sink); approval
 * requests themselves are announced by the gateway. A failed run is not retried by itself; a workflow with a
 * `fallback` agent finishes a run whose typed step failed (drift) agentically instead, and says so (D18, D92).
 */
type Env = Readonly<Record<string, string | undefined>>;

export interface RunRequest {
  readonly home: string;
  readonly workflow: Workflow;
  readonly key: string;
  readonly trigger: RunTrigger;
  readonly now: () => string;
  readonly sandbox?: boolean;
  /** A shadow run of this pack's candidate version (D108); always a sandbox run. */
  readonly shadow?: string;
  readonly env?: Env;
}

async function prepare(request: RunRequest, record: RunRecord): Promise<Exec> {
  const ctx = { ...(await toolContext(request.home, "runner", DEFAULT_TOOLS, request.now)), sandbox: record.sandbox, run: `${record.workflow}/${record.run_id}` };
  const state = (await loadState(request.home)) ?? undefined;
  let backend: Promise<JudgeBackend> | undefined;
  return { home: request.home, ctx, state, contract: await loadPinnedContract(request.home), backend: () => (backend ??= judgeBackend(request.home, state, request.env)), ...(request.env ? { env: request.env } : {}) };
}

/** The data a run starts from: `run`, and `event` (the inbox message, untrusted) for an event trigger. */
async function scopeOf(home: string, record: RunRecord): Promise<Record<string, unknown>> {
  const run = { id: record.run_id, key: record.key, trigger: record.trigger.kind, scheduled_for: record.trigger.scheduled_for ?? null };
  const previous = await previousOutputs(home, record);
  if (record.trigger.sample_event !== undefined) return { run, previous, event: record.trigger.sample_event };
  if (record.trigger.inbox_id === undefined) return { run, previous };
  const event = (await listInbox(home)).find((item) => item.id === record.trigger.inbox_id);
  return { run, previous, event: event ?? null };
}

/** Escalation: a short internal message to the decision maker; a message that cannot go out is audited instead. */
async function tellDecisionMaker(exec: Exec, record: RunRecord, text: string): Promise<void> {
  const name = exec.state?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(exec.ctx, "channel.notify", { member: name, text });
    } catch (failure) {
      if (!(failure instanceof InputError || failure instanceof ToolRefusal || failure instanceof ActionFailure)) throw failure;
      error = failure.message;
    }
  }
  await auditRun(exec.home, exec.ctx.now(), "run.escalated", record, { text, delivered: error === null, ...(error ? { error } : {}) });
}
const agentRun = (exec: Exec, record: RunRecord, step: string, spec: AgentSpec, input: unknown, startedAt: string): AgentRun => ({ exec, record, step, spec, input, startedAt });

async function runStep(exec: Exec, record: RunRecord, step: WorkflowStep, scope: Scope): Promise<StepOutcome> {
  const startedAt = exec.ctx.now();
  const log = await loadStep(exec.home, record, step.id);
  if (log?.status === "waiting" && step.kind === "agent") return resumeAgent(agentRun(exec, record, step.id, step.agent, log.input, log.started_at), log);
  if (log?.status === "waiting") return checkApproval(exec, record, log);
  if (log?.status === "failed" && log.error === TASK_INTERRUPTED) {
    return { kind: "stop", status: "failed", reason: `step '${step.id}': ${TASK_INTERRUPTED}, so the agent may already have acted. Check with 'taskfollow why --run ${record.run_id}' before running it again` };
  }
  if (step.when !== undefined && !holds(step.when, scope)) {
    await saveStep(exec.home, record, { step: step.id, status: "done", started_at: startedAt, finished_at: startedAt, duration_ms: 0, input_fingerprint: fingerprint(null), output: null, skipped: true });
    return { kind: "done", output: null, actions: 0, needs_human: 0 };
  }
  if (step.kind === "tool") return runTool(exec, record, step, scope, startedAt);
  if (step.kind === "judge") return runJudge(exec, record, step, scope, startedAt);
  if (step.kind === "task") return runTaskStep(exec, record, step, scope, startedAt);
  if (step.kind === "calc") return runCalc(exec, record, step, scope, startedAt);
  if (step.kind === "agent") return continueAgent(agentRun(exec, record, step.id, step.agent, step.agent.input === undefined ? { ...scope } : interpolate(step.agent.input, scope), startedAt), []);
  return runApprove(exec, record, step, scope, startedAt);
}

/**
 * A step that throws a domain error fails the run; anything else (a bug, a damaged file) leaves it resumable. A pause
 * that came while the run was under way stops it before its next step (D101): no further model call or action.
 */
async function guarded(exec: Exec, record: RunRecord, step: WorkflowStep, scope: Scope): Promise<StepOutcome> {
  if (await isPaused(exec.home)) return { kind: "stop", status: "partial", reason: PAUSED_REASON };
  try {
    return await runStep(exec, record, step, scope);
  } catch (error) {
    if (!(error instanceof InputError || error instanceof ToolRefusal || error instanceof ActionFailure)) throw error;
    const at = exec.ctx.now();
    await saveStep(exec.home, record, { step: step.id, status: "failed", started_at: at, finished_at: at, duration_ms: 0, input_fingerprint: fingerprint(null), error: error.message });
    return { kind: "stop", status: "failed", reason: `step '${step.id}' failed: ${error.message}`, drift: step.kind !== "agent" && step.kind !== "task" };
  }
}

async function finish(exec: Exec, record: RunRecord, status: RunRecord["status"], reason?: string): Promise<RunRecord> {
  const { waiting_on: _waiting, reason: _old, ...rest } = record;
  const done: RunRecord = { ...rest, status, finished_at: exec.ctx.now(), ...(reason ? { reason } : {}) };
  await saveRun(exec.home, done);
  await auditRun(exec.home, exec.ctx.now(), "run.finished", done, { actions: done.actions, needs_human: done.needs_human, ...(reason ? { reason } : {}) });
  const where = `run ${done.run_id} of workflow '${done.workflow}'`;
  if (status === "failed") await tellDecisionMaker(exec, done, `The ${where} failed: ${reason ?? "unknown reason"}. It is not retried by itself; 'taskfollow run ${done.workflow}' runs it again.`);
  else if (done.needs_human > 0) await tellDecisionMaker(exec, done, `The ${where} has ${done.needs_human} judgement(s) that need a person; see runs/${done.workflow}/${done.run_id} in the engine home.`);
  return done;
}

/** After drift the run continues with the steps done before it, then the workflow's fallback agent (D18). */
function plan(workflow: Workflow, record: RunRecord): readonly WorkflowStep[] {
  if (!record.fallback_from || !workflow.fallback) return workflow.steps;
  const failed = workflow.steps.findIndex((step) => step.id === record.fallback_from?.step);
  return [...workflow.steps.slice(0, Math.max(0, failed)), { id: FALLBACK_STEP, kind: "agent", agent: workflow.fallback }];
}

async function fallBack(exec: Exec, record: RunRecord, step: string, error: string): Promise<RunRecord> {
  const marked: RunRecord = { ...record, fallback_from: { step, error } };
  await saveRun(exec.home, marked);
  await auditRun(exec.home, exec.ctx.now(), "run.fallback", marked, { step, error });
  await tellDecisionMaker(exec, marked, `Drift in run ${marked.run_id} of workflow '${marked.workflow}': ${error}. This run falls back to the workflow's agent; check what it did.`);
  return marked;
}

async function execute(exec: Exec, workflow: Workflow, start: RunRecord): Promise<RunRecord> {
  let record = start;
  const scope: Record<string, unknown> = { ...(await scopeOf(exec.home, record)), ...(record.fallback_from ? { failure: record.fallback_from } : {}) };
  for (const step of plan(workflow, record)) {
    const log = await loadStep(exec.home, record, step.id);
    if (log?.status === "done") {
      scope[step.id] = log.output;
      continue;
    }
    const outcome = await guarded(exec, record, step, scope);
    if (outcome.kind === "wait") {
      record = { ...record, status: "waiting", waiting_on: outcome.approval };
      await saveRun(exec.home, record);
      await auditRun(exec.home, exec.ctx.now(), "run.waiting", record, { step: step.id, approval: outcome.approval });
      return record;
    }
    if (outcome.kind === "stop" && outcome.drift && workflow.fallback && !record.fallback_from) return execute(exec, workflow, await fallBack(exec, record, step.id, outcome.reason));
    if (outcome.kind === "stop") return finish(exec, record, outcome.status, outcome.reason);
    scope[step.id] = outcome.output;
    record = { ...record, actions: record.actions + outcome.actions, needs_human: record.needs_human + outcome.needs_human, ...(outcome.urgent ? { urgent: true } : {}) };
    await saveRun(exec.home, record);
  }
  return finish(exec, record, record.needs_human > 0 ? "partial" : "completed");
}

/** Continues an unfinished run (waiting for an approval, or left running by a process that is gone). */
export async function resumeRun(request: RunRequest, record: RunRecord): Promise<RunRecord> {
  if (FINISHED.includes(record.status)) return record;
  if (record.status === "waiting" && record.waiting_on !== undefined && (await getApproval(request.home, record.waiting_on, request.now())).status === "pending") return record;
  const exec = await prepare(request, record);
  const running: RunRecord = { ...record, status: "running", pid: process.pid };
  await saveRun(request.home, running);
  return execute(exec, request.workflow, running);
}

/** Starts the run for this key; a key that already has a run is never started twice (§10.7). */
export async function startRun(request: RunRequest): Promise<RunRecord> {
  if (await isPaused(request.home)) throw new InputError(`No run starts: ${PAUSED_REASON}`);
  const existing = await runForKey(request.home, request.key);
  if (existing) return FINISHED.includes(existing.status) ? existing : resumeRun(request, existing);
  const at = request.trigger.scheduled_for ?? request.now();
  const record: RunRecord = {
    workflow: request.workflow.id, run_id: runIdFor(request.key, at), key: request.key, trigger: request.trigger, version: request.workflow.version,
    status: "running", started_at: request.now(), sandbox: request.sandbox === true || request.shadow !== undefined || (await runsInSandbox(request.home, request.workflow.id)), pid: process.pid, actions: 0, needs_human: 0,
    ...(request.shadow ? { shadow: request.shadow } : {}),
  };
  if (!(await claimRun(request.home, record))) {
    // Another process claimed the key first and runs it; this one never starts or resumes that run.
    const raced = await runForKey(request.home, request.key);
    if (!raced) throw new ActionFailure(`The run for '${request.key}' is busy: another process claimed it a moment ago; it is not started twice`);
    return raced;
  }
  const exec = await prepare(request, record);
  await auditRun(request.home, request.now(), "run.started", record, { trigger: record.trigger.kind, version: record.version, sandbox: record.sandbox });
  return execute(exec, request.workflow, record);
}
