import { runAction, runCheck } from "./actions.js";
import { crashPoint } from "./crash.js";
import { AGENT_FORBIDDEN_KINDS, validateInput } from "./inputs.js";
import type { AuditHead, InstallState, Solution, StepDef, StepRecord, StepStatus } from "./types.js";

export const MAX_VERIFY_ATTEMPTS = 3;
export const RESUME_HINT = "installer resume";

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
  readonly resume: string;
}

export type NextResult =
  | { readonly status: "step"; readonly view: StepView }
  | { readonly status: "blocked"; readonly view: StepView }
  | { readonly status: "complete" };

export interface Advanced {
  readonly state: InstallState;
  readonly result: NextResult;
}

export type VerifyResult =
  | { readonly status: "passed" }
  | { readonly status: "failed"; readonly hint: string; readonly retry: true }
  | { readonly status: "blocked"; readonly hint: string; readonly retry: false };

const SETTLED: readonly StepStatus[] = ["done", "skipped"];

export function recordOf(state: InstallState, stepId: string): StepRecord | undefined {
  return state.steps[stepId];
}

export function initialState(ref: string, solution: Solution, now: string, recipeVersion?: string): InstallState {
  const pinned = { ref, id: solution.id, version: solution.version, ...(recipeVersion ? { recipe_version: recipeVersion } : {}) };
  return { schema: 1, solution: pinned, started_at: now, steps: {} };
}

/** First step that is not settled; non-blocking blocked steps are passed over. */
export function currentStep(solution: Solution, state: InstallState): StepDef | null {
  for (const step of solution.steps) {
    const record = recordOf(state, step.step_id);
    if (record && SETTLED.includes(record.status)) continue;
    if (record?.status === "blocked" && !step.blocking) continue;
    return step;
  }
  return null;
}

/** The command that retries a failed step: verify-type steps rerun through resume, the rest through verify. */
export function retryCommand(step: StepDef): string {
  return step.type === "verify" ? RESUME_HINT : `installer verify ${step.step_id}`;
}

function viewOf(step: StepDef, record: StepRecord | undefined): StepView {
  return {
    step,
    status: record?.status ?? "pending",
    attempts: record?.attempts ?? 0,
    ...(record?.hint ? { hint: record.hint } : {}),
    resume: record?.status === "failed" ? retryCommand(step) : RESUME_HINT,
  };
}

/** Audit first, then save: a crash in between repeats an audit line but never loses one. */
export async function transition(deps: EngineDeps, state: InstallState, step: StepDef, record: StepRecord, actor: Actor): Promise<InstallState> {
  const head = await deps.audit({ actor, event: `step.${record.status}`, ref: step.step_id, payload: { status: record.status, attempts: record.attempts ?? 0 } });
  const next: InstallState = { ...state, steps: { ...state.steps, [step.step_id]: record }, audit_head: head };
  await deps.save(next);
  return next;
}

export async function runVerify(deps: EngineDeps, state: InstallState, step: StepDef, actor: Actor): Promise<{ state: InstallState; result: VerifyResult }> {
  if (!step.verify) throw new EngineError(`Step '${step.step_id}' has nothing to verify`);
  const check = await runCheck(deps.home, step.verify);
  if (check.ok) {
    return { state: await transition(deps, state, step, { status: "done", at: deps.now(), by: actor }, actor), result: { status: "passed" } };
  }
  const attempts = (recordOf(state, step.step_id)?.attempts ?? 0) + 1;
  const hint = check.hint ?? "Check failed";
  if (attempts >= MAX_VERIFY_ATTEMPTS) {
    const record: StepRecord = { status: "blocked", at: deps.now(), attempts, hint, reason: `check failed ${attempts} times` };
    return { state: await transition(deps, state, step, record, actor), result: { status: "blocked", hint, retry: false } };
  }
  const record: StepRecord = { status: "failed", at: deps.now(), attempts, hint };
  return { state: await transition(deps, state, step, record, actor), result: { status: "failed", hint, retry: true } };
}

/** Runs engine-owned steps until a human/agent step, a blocking problem, or completion. */
export async function advance(deps: EngineDeps, state: InstallState): Promise<Advanced> {
  let current = state;
  for (;;) {
    const step = currentStep(deps.solution, current);
    if (!step) return { state: current, result: { status: "complete" } };
    const record = recordOf(current, step.step_id);
    if (record?.status === "blocked") return { state: current, result: { status: "blocked", view: viewOf(step, record) } };
    if (step.type === "auto" && step.auto) {
      await runAction(deps.home, step.auto);
      crashPoint("engine:after-action");
      current = await transition(deps, current, step, { status: "done", at: deps.now(), by: "engine" }, "engine");
      continue;
    }
    if (step.type === "verify" && (record === undefined || record.status === "pending")) {
      current = (await runVerify(deps, current, step, "engine")).state;
      continue;
    }
    return { state: current, result: { status: "step", view: viewOf(step, record) } };
  }
}

export async function start(deps: EngineDeps, existing: InstallState | null, ref: string, recipeVersion?: string): Promise<Advanced> {
  if (existing) {
    const same = existing.solution.id === deps.solution.id && existing.solution.version === deps.solution.version;
    if (!same) throw new EngineError(`This home already has an install of '${existing.solution.id}@${existing.solution.version}'; use a different --home`);
    return advance(deps, existing);
  }
  const head = await deps.audit({ actor: "human", event: "install.started", ref, payload: { id: deps.solution.id, version: deps.solution.version } });
  const fresh: InstallState = { ...initialState(ref, deps.solution, deps.now(), recipeVersion), audit_head: head };
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
    if (step.verify) throw new EngineError(`Step '${step.step_id}' is confirmed by a check: run 'installer verify ${step.step_id}'`);
    if (payload.kind !== "done") throw new EngineError(`Step '${step.step_id}' takes no value: use --done`);
    return { status: "done", at: deps.now(), by: "human" };
  }
  const hint = step.type === "agent_action" ? `: perform the intent, then run 'installer verify ${step.step_id}'` : "";
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
  if (!step.verify) throw new EngineError(`Step '${stepId}' has no check; use 'installer submit'`);
  const actor: Actor = step.type === "agent_action" ? "agent" : step.type === "human_action" ? "human" : "engine";
  const verified = await runVerify(deps, settled, step, actor);
  const { state: final, result: next } = await advance(deps, verified.state);
  return { state: final, result: verified.result, next };
}

/** Reopens blocked steps with fresh attempts and failed steps with their attempts kept, then continues. */
export async function resume(deps: EngineDeps, state: InstallState): Promise<Advanced> {
  let current = state;
  for (const step of deps.solution.steps) {
    const record = recordOf(current, step.step_id);
    if (record?.status === "blocked") {
      current = await transition(deps, current, step, { status: "pending", at: deps.now(), attempts: 0 }, "human");
    } else if (record?.status === "failed") {
      current = await transition(deps, current, step, { status: "pending", at: deps.now(), attempts: record.attempts ?? 0 }, "human");
    }
  }
  return advance(deps, current);
}
