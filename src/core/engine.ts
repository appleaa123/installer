import { runAction, runCheck, type CheckResult } from "./actions.js";
import { crashPoint } from "./crash.js";
import { ActionFailure } from "./failure.js";
import { AGENT_FORBIDDEN_KINDS, validateInput } from "./inputs.js";
import { stepVisible, visibleSteps } from "./visibility.js";
import type { Action, AuditHead, InstallState, Solution, StatePatch, StepDef, StepRecord, StepStatus, StepType } from "./types.js";

export const MAX_VERIFY_ATTEMPTS = 3;
export const RESUME_HINT = "taskfollow resume";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export type Actor = "human" | "agent" | "engine";

export interface AuditEvent {
  readonly actor: Actor;
  readonly event: string;
  readonly ref: string;
  readonly payload: unknown;
}

export interface EngineDeps {
  readonly home: string;
  readonly solution: Solution;
  readonly now: () => string;
  readonly save: (state: InstallState) => Promise<void>;
  readonly audit: (event: AuditEvent) => Promise<AuditHead>;
}

export interface StepView {
  readonly step: StepDef;
  readonly status: StepStatus;
  readonly attempts: number;
  readonly hint?: string;
  readonly hints?: readonly string[];
  readonly resume: string;
}

export type NextResult =
  | { readonly status: "step"; readonly view: StepView }
  | { readonly status: "blocked"; readonly view: StepView }
  | { readonly status: "complete" };

export interface Advanced {
  readonly state: InstallState;
  readonly result: NextResult;
  /** Something the person should hear about the change (for example a skill folder that was not put back). */
  readonly note?: string;
}

export type VerifyResult =
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly hint: string; readonly retry: true }
  | { readonly status: "blocked"; readonly hint: string; readonly retry: false };

const SETTLED: readonly StepStatus[] = ["done", "skipped"];
/** Engine-owned steps are rerun by `taskfollow resume`; a person or agent reruns the rest with `taskfollow verify`. */
const RETRIED_BY_RESUME: readonly StepType[] = ["verify", "auto"];

export function recordOf(state: InstallState, stepId: string): StepRecord | undefined {
  return state.steps[stepId];
}

/** Facts known only at `start` time that later steps read back (D54: the agent's folder, D51: the Skills Wiki URL). */
export type StartExtras = Partial<Pick<InstallState, "work_dir" | "skillswiki">>;

export function initialState(ref: string, solution: Solution, now: string, recipeVersion?: string, extras: StartExtras = {}): InstallState {
  const pinned = { ref, id: solution.id, version: solution.version, ...(recipeVersion ? { recipe_version: recipeVersion } : {}) };
  return { schema: 1, solution: pinned, started_at: now, steps: {}, ...extras };
}

/** First step that is not settled; non-blocking blocked steps are passed over. */
export function currentStep(solution: Solution, state: InstallState): StepDef | null {
  for (const step of visibleSteps(solution, state)) {
    const record = recordOf(state, step.step_id);
    if (record && SETTLED.includes(record.status)) continue;
    if (record?.status === "blocked" && !step.blocking) continue;
    return step;
  }
  return null;
}

/** The command that retries a failed step: engine-owned steps rerun through resume, the rest through verify. */
export function retryCommand(step: StepDef): string {
  return RETRIED_BY_RESUME.includes(step.type) ? RESUME_HINT : `taskfollow verify ${step.step_id}`;
}

function viewOf(step: StepDef, record: StepRecord | undefined, profile?: string | null): StepView {
  const hints = profile ? step.hints?.[profile] : undefined;
  const retrying = record?.status === "failed" || (record?.status === "pending" && (record.attempts ?? 0) > 0);
  return {
    step,
    status: record?.status ?? "pending",
    attempts: record?.attempts ?? 0,
    ...(record?.hint ? { hint: record.hint } : {}),
    ...(hints ? { hints } : {}),
    resume: retrying ? retryCommand(step) : RESUME_HINT,
  };
}

/** Audit first, then save: a crash in between repeats an audit line but never loses one. */
export async function transition(deps: EngineDeps, state: InstallState, step: StepDef, record: StepRecord, actor: Actor): Promise<InstallState> {
  const head = await deps.audit({ actor, event: `step.${record.status}`, ref: step.step_id, payload: { status: record.status, attempts: record.attempts ?? 0 } });
  const next: InstallState = { ...state, steps: { ...state.steps, [step.step_id]: record }, audit_head: head };
  await deps.save(next);
  return next;
}

/**
 * One more failure of a step: `failed` with the hint, `blocked` on the third (D53: actions mirror checks). An
 * auto step that is not blocking is blocked at once, so the install goes on past it (D175); `resume` tries it once
 * more each time. A step a person verifies keeps its three tries.
 */
async function failStep(deps: EngineDeps, state: InstallState, step: StepDef, hint: string, actor: Actor, what: "check" | "action"): Promise<{ state: InstallState; result: VerifyResult }> {
  const attempts = (recordOf(state, step.step_id)?.attempts ?? 0) + 1;
  if (attempts >= MAX_VERIFY_ATTEMPTS || (!step.blocking && step.type === "auto")) {
    const record: StepRecord = { status: "blocked", at: deps.now(), attempts, hint, reason: `${what} failed ${attempts} times` };
    return { state: await transition(deps, state, step, record, actor), result: { status: "blocked", hint, retry: false } };
  }
  const record: StepRecord = { status: "failed", at: deps.now(), attempts, hint };
  return { state: await transition(deps, state, step, record, actor), result: { status: "failed", hint, retry: true } };
}

/** A check that could not run (network, keychain) counts as a failed check with its message as the hint. */
function asCheckResult(error: unknown): CheckResult {
  if (error instanceof ActionFailure) return { ok: false, hint: error.message };
  throw error;
}

export async function runVerify(deps: EngineDeps, state: InstallState, step: StepDef, actor: Actor): Promise<{ state: InstallState; result: VerifyResult }> {
  if (!step.verify) throw new EngineError(`Step '${step.step_id}' has nothing to verify`);
  const check = await runCheck(deps.home, step.verify, state).catch(asCheckResult);
  if (check.ok) {
    return { state: await transition(deps, state, step, { status: "done", at: deps.now(), by: actor }, actor), result: { status: "passed" } };
  }
  return failStep(deps, state, step, check.hint ?? "Check failed", actor, "check");
}

/** Runs an auto step; an ActionFailure becomes a failed (then blocked) step, anything else still throws. */
async function runAuto(deps: EngineDeps, state: InstallState, step: StepDef, action: Action): Promise<InstallState> {
  let patch: StatePatch;
  try {
    patch = await runAction(deps.home, action, state);
  } catch (error) {
    if (!(error instanceof ActionFailure)) throw error;
    return (await failStep(deps, state, step, error.message, "engine", "action")).state;
  }
  crashPoint("engine:after-action");
  return transition(deps, { ...state, ...patch }, step, { status: "done", at: deps.now(), by: "engine" }, "engine");
}

/** Runs engine-owned steps until a human/agent step, a blocking problem, or completion. */
export async function advance(deps: EngineDeps, state: InstallState): Promise<Advanced> {
  let current = state;
  for (;;) {
    const step = currentStep(deps.solution, current);
    if (!step) return { state: current, result: { status: "complete" } };
    const record = recordOf(current, step.step_id);
    if (record?.status === "blocked") return { state: current, result: { status: "blocked", view: viewOf(step, record, current.runtime?.profile) } };
    const untried = record === undefined || record.status === "pending";
    if (step.type === "auto" && step.auto && untried) {
      current = await runAuto(deps, current, step, step.auto);
      continue;
    }
    if (step.type === "verify" && untried) {
      current = (await runVerify(deps, current, step, "engine")).state;
      continue;
    }
    return { state: current, result: { status: "step", view: viewOf(step, record, current.runtime?.profile) } };
  }
}

export async function start(deps: EngineDeps, existing: InstallState | null, ref: string, recipeVersion?: string, extras?: StartExtras): Promise<Advanced> {
  if (existing) {
    const same = existing.solution.id === deps.solution.id && existing.solution.version === deps.solution.version;
    if (!same) throw new EngineError(`This home already has an install of '${existing.solution.id}@${existing.solution.version}'; use a different --home`);
    return advance(deps, existing);
  }
  const head = await deps.audit({ actor: "human", event: "install.started", ref, payload: { id: deps.solution.id, version: deps.solution.version } });
  const fresh: InstallState = { ...initialState(ref, deps.solution, deps.now(), recipeVersion, extras), audit_head: head };
  await deps.save(fresh);
  return advance(deps, fresh);
}

export type SubmitPayload = { readonly kind: "value"; readonly value: unknown } | { readonly kind: "done" };

export interface Verified {
  readonly state: InstallState;
  readonly result: VerifyResult;
  readonly next: NextResult;
}

function requireKnown(deps: EngineDeps, stepId: string): StepDef {
  const step = deps.solution.steps.find((candidate) => candidate.step_id === stepId);
  if (!step) throw new EngineError(`Unknown step '${stepId}'`);
  return step;
}

function requireCurrent(deps: EngineDeps, state: InstallState, stepId: string): StepDef {
  const step = requireKnown(deps, stepId);
  if (!stepVisible(step, state)) throw new EngineError(`Step '${stepId}' is not part of your setup: it depends on a choice you made earlier`);
  const current = currentStep(deps.solution, state);
  if (!current || current.step_id !== stepId) {
    const where = current ? `; current step is '${current.step_id}'` : "; the install has no pending step";
    throw new EngineError(`Step '${stepId}' is not the current step${where}`);
  }
  if (recordOf(state, stepId)?.status === "blocked") throw new EngineError(`Step '${stepId}' is blocked; run '${RESUME_HINT}' first`);
  return step;
}

function submittedRecord(deps: EngineDeps, step: StepDef, payload: SubmitPayload): StepRecord {
  if (step.type === "ask") {
    if (payload.kind !== "value") throw new EngineError(`Step '${step.step_id}' needs an answer: use --value`);
    return { status: "done", at: deps.now(), by: "human", value: validateInput(step.input, payload.value) };
  }
  if (step.type === "human_action") {
    if (step.input && AGENT_FORBIDDEN_KINDS.includes(step.input.kind)) {
      throw new EngineError(`Step '${step.step_id}' is completed by the local browser page, never through submit`);
    }
    if (step.verify) throw new EngineError(`Step '${step.step_id}' is confirmed by a check: run 'taskfollow verify ${step.step_id}'`);
    if (payload.kind !== "done") throw new EngineError(`Step '${step.step_id}' takes no value: use --done`);
    return { status: "done", at: deps.now(), by: "human" };
  }
  const hint = step.type === "agent_action" ? `: perform the intent, then run 'taskfollow verify ${step.step_id}'` : "";
  throw new EngineError(`Step '${step.step_id}' (${step.type}) cannot be submitted${hint}`);
}

export async function submit(deps: EngineDeps, state: InstallState, stepId: string, payload: SubmitPayload): Promise<Advanced> {
  requireKnown(deps, stepId);
  const settled = (await advance(deps, state)).state;
  const step = requireCurrent(deps, settled, stepId);
  const record = submittedRecord(deps, step, payload);
  return advance(deps, await transition(deps, settled, step, record, "human"));
}

export async function verifyStep(deps: EngineDeps, state: InstallState, stepId: string): Promise<Verified> {
  requireKnown(deps, stepId);
  const settled = (await advance(deps, state)).state;
  const step = requireCurrent(deps, settled, stepId);
  if (!step.verify) throw new EngineError(`Step '${stepId}' has no check; use 'taskfollow submit'`);
  const actor: Actor = step.type === "agent_action" ? "agent" : step.type === "human_action" ? "human" : "engine";
  const verified = await runVerify(deps, settled, step, actor);
  const { state: final, result: next } = await advance(deps, verified.state);
  return { state: final, result: verified.result, next };
}

/**
 * Changes the answer of a question that was already answered (`taskfollow add`, D134), audited as `step.revised`, then
 * continues: steps that the new answer brings into view become the current step even if the install had finished.
 */
export async function revise(deps: EngineDeps, state: InstallState, stepId: string, value: unknown, actor: Actor): Promise<Advanced> {
  const step = requireKnown(deps, stepId);
  const record = recordOf(state, stepId);
  if (step.type !== "ask" || record?.status !== "done") throw new EngineError(`Step '${stepId}' is not a question that was answered`);
  const valid = validateInput(step.input, value);
  const head = await deps.audit({ actor, event: "step.revised", ref: stepId, payload: { from: record.value ?? null, to: valid as never } });
  const next: InstallState = { ...state, steps: { ...state.steps, [stepId]: { ...record, at: deps.now(), value: valid } }, audit_head: head };
  await deps.save(next);
  return advance(deps, next);
}

/** Reopens blocked steps with fresh attempts and failed steps with their attempts kept, then continues. */
export async function resume(deps: EngineDeps, state: InstallState): Promise<Advanced> {
  let current = state;
  for (const step of visibleSteps(deps.solution, state)) {
    const record = recordOf(current, step.step_id);
    if (record?.status === "blocked") {
      current = await transition(deps, current, step, { status: "pending", at: deps.now(), attempts: 0 }, "human");
    } else if (record?.status === "failed") {
      current = await transition(deps, current, step, { status: "pending", at: deps.now(), attempts: record.attempts ?? 0 }, "human");
    }
  }
  return advance(deps, current);
}
