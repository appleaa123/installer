import { makeApprovedCall, prepareAgentCall } from "./agent-call.js";
import { getApproval, isAgentCall, requestApproval, type PreparedAction } from "./approvals.js";
import { calculate } from "./calc.js";
import { interpolate, lookup, type Scope } from "./expressions.js";
import { InputError } from "./inputs.js";
import { raiseAlert } from "./alerts.js";
import { approveByGrant, proposeIfEarned } from "./autonomy.js";
import { askJudge, protectedFields, runContextTools, stripFields, type ContextCall, type JudgeBackend } from "./judge.js";
import { needsApproval } from "./levels.js";
import { pinnedSkill } from "./packs.js";
import { fingerprint, newestStepOutput, saveStep, type RunRecord, type StepLog } from "./runs.js";
import { TOKEN_ARG, invokeTool, prepareAction, requireTool, type ToolArgs, type ToolContext } from "./tools.js";
import type { DataContract } from "./contract.js";
import type { InstallState } from "./types.js";
import type { ArgsTemplate, WorkflowStep } from "./workflow.js";

/**
 * One step of a run (spec §10.2, D87). Tools act through Plan 4's gate (`invokeTool`): an L0 or L1 call runs; an
 * L2 or L3 call becomes an approval item for exactly that call and the run waits (§10.9 policy escalation, also
 * what an `approve` step asks for); once approved, the runner makes the same call with the item's token, so the
 * gate checks the hash, the role and single use as for any caller. Judges only answer (D83). No argument a
 * workflow or a judge produces can carry an approval token (R8).
 */
export interface Exec {
  readonly home: string;
  readonly ctx: ToolContext;
  readonly state: InstallState | undefined;
  readonly contract: DataContract | null;
  readonly backend: () => Promise<JudgeBackend>;
  /** The workflow's skills block for this run's prompts (9.12 item 2, D153), loaded once on first use; null without skills. */
  readonly skills: () => Promise<string | null>;
  /** The environment a task step's agent starts from (narrowed further by agent-task.ts). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type StepOutcome =
  | { readonly kind: "done"; readonly output: unknown; readonly actions: number; readonly needs_human: number; readonly urgent?: boolean }
  | { readonly kind: "wait"; readonly approval: number }
  /** `completed` ends a run early with nothing to do and nobody needed (D171: no file to read). */
  | { readonly kind: "stop"; readonly status: "completed" | "partial" | "failed"; readonly reason: string; readonly drift?: boolean };

const now = (exec: Exec): string => exec.ctx.now();

/** Arguments for a call: the workflow's templates filled in; an approval token there is refused (R8). */
export function argsFor(template: unknown, scope: Scope, step: string): ToolArgs {
  const args = interpolate(template, scope);
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new InputError(`Step '${step}': the arguments must be an object`);
  if (Object.hasOwn(args, TOKEN_ARG)) throw new InputError(`Step '${step}': an argument named ${TOKEN_ARG} came from the run's data; only the runner passes tokens`);
  return args as ToolArgs;
}

function items(step: WorkflowStep, scope: Scope): readonly unknown[] {
  if (!("foreach" in step) || step.foreach === undefined) return [undefined];
  const list = lookup(scope, step.foreach.slice(2, -1));
  if (!Array.isArray(list)) throw new InputError(`Step '${step.id}': foreach ${step.foreach} is not a list`);
  return list;
}

async function save(exec: Exec, record: RunRecord, log: Omit<StepLog, "finished_at" | "duration_ms">): Promise<void> {
  const finished = now(exec);
  await saveStep(exec.home, record, { ...log, finished_at: finished, duration_ms: Math.max(0, Date.parse(finished) - Date.parse(log.started_at)) });
}

/** Asks a person to approve exactly this call; the run waits for the decision (§10.9 policy), unless a grant approves it (D94). */
async function escalate(exec: Exec, record: RunRecord, step: string, prepared: PreparedAction, request: { why: string; urgent: boolean; startedAt: string; policy: boolean }): Promise<StepOutcome> {
  const run = { workflow: record.workflow, run_id: record.run_id, step, ...(request.policy ? { policy: true } : {}) };
  const item = await requestApproval(exec.home, { prepared, why: request.why, urgent: request.urgent, via: "runner", run }, now(exec));
  const log: StepLog = { step, status: "waiting", started_at: request.startedAt, finished_at: now(exec), duration_ms: 0, input_fingerprint: fingerprint(prepared.args), approval: item.id };
  await saveStep(exec.home, record, log);
  if (await approveByGrant(exec.home, item, prepared, request.urgent, now(exec))) return checkApproval(exec, record, log);
  return { kind: "wait", approval: item.id };
}

/** Item 5: "last-run" becomes the newest inbox id the last run with a list read, or null on the first run. */
async function lastRunArgs(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "tool" }): Promise<ArgsTemplate> {
  if (step.last_run === undefined || typeof step.args === "string") return step.args;
  const read = await newestStepOutput(exec.home, record, step.id, step.last_run, (output) => typeof (output as { newest_id?: unknown } | null)?.newest_id === "number");
  const newest = typeof read === "object" && read !== null ? (read as { newest_id?: unknown }).newest_id : undefined;
  return { ...step.args, after: typeof newest === "number" ? newest : null };
}

export async function runTool(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "tool" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const outputs: unknown[] = [];
  let actions = 0;
  const list = items(step, scope);
  const template = await lastRunArgs(exec, record, step);
  for (const item of list) {
    const args = argsFor(template, { ...scope, item }, step.id);
    const prepared = await prepareAction(exec.ctx, requireTool(exec.ctx.registry, step.tool), args);
    if (needsApproval(prepared.level) && !exec.ctx.sandbox) {
      if (step.foreach !== undefined) throw new InputError(`Step '${step.id}': ${step.tool} is ${prepared.level} and needs an approval for each item; approve one call with an approve step instead`);
      return escalate(exec, record, step.id, prepared, { why: `Workflow '${record.workflow}' (step '${step.id}') wants to run ${step.tool}, which is ${prepared.level}`, urgent: record.urgent === true, startedAt, policy: true });
    }
    outputs.push(await invokeTool(exec.ctx, step.tool, args));
    actions += prepared.level === "L0" ? 0 : 1;
  }
  const output = step.foreach === undefined ? outputs[0] : outputs;
  await save(exec, record, { step: step.id, status: "done", started_at: startedAt, input_fingerprint: fingerprint(list), output });
  return { kind: "done", output, actions, needs_human: 0 };
}

/** §11.7: answers that say `urgent: true`, when the step's schema declares that field (the recipe decides, D26). */
function urgentAnswers(schema: Readonly<Record<string, unknown>>, outputs: readonly unknown[]): unknown[] {
  const { properties: declared } = schema;
  if (typeof declared !== "object" || declared === null || !Object.hasOwn(declared, "urgent")) return [];
  return outputs.filter((output) => typeof output === "object" && output !== null && (output as Record<string, unknown>).urgent === true);
}

/** The field names the step's schema declares: the only parts of an answer an alert shows (labelled, D95). */
const declaredFields = ({ properties: declared }: Readonly<Record<string, unknown>>): string[] => (typeof declared === "object" && declared !== null ? Object.keys(declared) : []);

export async function runJudge(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "judge" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const spec = step.judge;
  const backend = await exec.backend();
  // D107: the pinned copy of the skill file, never whatever Skills Wiki serves today (a shadow run reads the candidate, D108).
  const skill = spec.skill ? await pinnedSkill(exec.home, exec.state?.skillswiki?.url, spec.skill, now(exec), record.shadow) : null;
  const hidden = protectedFields(exec.contract);
  const [outputs, calls, needs, inputs]: [unknown[], ContextCall[], { index: number; reason: string }[], unknown[]] = [[], [], [], []];
  for (const [index, item] of items(step, scope).entries()) {
    const itemScope = { ...scope, item };
    const input = stripFields(spec.input === undefined ? (item ?? null) : interpolate(spec.input, itemScope), hidden);
    const context = (await runContextTools(exec.ctx, spec, itemScope)).map((call) => ({ ...call, result: stripFields(call.result, hidden) as ContextCall["result"] }));
    const outcome = await askJudge(backend, spec, input, context, skill, await exec.skills());
    inputs.push(input);
    calls.push(...context);
    if (outcome.status === "ok") outputs.push(outcome.value);
    else needs.push({ index, reason: outcome.reason });
  }
  const output = step.foreach === undefined ? (outputs[0] ?? null) : outputs;
  await save(exec, record, { step: step.id, status: "done", started_at: startedAt, input_fingerprint: fingerprint(inputs), output, context_calls: calls, ...(needs.length > 0 ? { needs_human: needs } : {}) });
  const urgent = urgentAnswers(spec.schema, outputs);
  if (urgent.length > 0) await raiseAlert(exec.ctx, exec.state?.roles, { workflow: record.workflow, run_id: record.run_id, step: step.id }, { fields: declaredFields(spec.schema), answers: urgent });
  return { kind: "done", output, actions: 0, needs_human: needs.length, ...(urgent.length > 0 ? { urgent: true } : {}) };
}

export async function runApprove(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "approve" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const args = argsFor(step.args, scope, step.id);
  if (step.agent_call) {
    const prepared = prepareAgentCall(step.id, step.tool, args);
    if (exec.ctx.sandbox) {
      await save(exec, record, { step: step.id, status: "done", started_at: startedAt, input_fingerprint: fingerprint(args), output: null, skipped: true });
      return { kind: "done", output: null, actions: 0, needs_human: 0 };
    }
    return escalate(exec, record, step.id, prepared, { why: step.why, urgent: step.urgent || record.urgent === true, startedAt, policy: false });
  }
  const prepared = await prepareAction(exec.ctx, requireTool(exec.ctx.registry, step.tool), args);
  if (!needsApproval(prepared.level)) throw new InputError(`Step '${step.id}': ${step.tool} is ${prepared.level} and needs no approval; make it a tool step`);
  if (exec.ctx.sandbox) {
    const output = await invokeTool(exec.ctx, step.tool, args);
    await save(exec, record, { step: step.id, status: "done", started_at: startedAt, input_fingerprint: fingerprint(args), output });
    return { kind: "done", output, actions: 1, needs_human: 0 };
  }
  return escalate(exec, record, step.id, prepared, { why: step.why, urgent: step.urgent || record.urgent === true, startedAt, policy: false });
}

/** A waiting step: approved → the same call with the token; rejected → the run stops; expired → it fails. */
export async function checkApproval(exec: Exec, record: RunRecord, log: StepLog): Promise<StepOutcome> {
  const id = log.approval ?? 0;
  const item = await getApproval(exec.home, id, now(exec));
  if (item.status === "pending") return { kind: "wait", approval: id };
  if (item.status === "approved" && item.token && isAgentCall(item)) return makeApprovedCall(exec, record, log, item, item.token);
  if (item.status === "approved" && item.token) {
    const output = await invokeTool(exec.ctx, item.action.tool, { ...item.action.args, [TOKEN_ARG]: item.token });
    await save(exec, record, { ...log, status: "done", output });
    await proposeIfEarned(exec.ctx, exec.state?.roles, item);
    return { kind: "done", output, actions: 1, needs_human: 0 };
  }
  const rejected = item.status === "rejected";
  const reason = rejected ? `approval ${id} was rejected${item.decision?.reason ? `: ${item.decision.reason}` : ""}` : `approval ${id} is ${item.status}`;
  await save(exec, record, { ...log, status: rejected ? "rejected" : "failed", error: reason });
  return { kind: "stop", status: rejected ? "partial" : "failed", reason };
}

/** A calc step (D144): arithmetic only, no model. `compare` that has no value yet (the first run) compares with nothing. */
export async function runCalc(exec: Exec, record: RunRecord, step: WorkflowStep & { kind: "calc" }, scope: Scope, startedAt: string): Promise<StepOutcome> {
  const spec = step.calc;
  const list = interpolate(spec.from, scope);
  const compare = spec.compare === undefined ? undefined : (lookup(scope, spec.compare.slice(2, -1)) ?? null);
  const output = calculate(list, { sum: spec.sum, ...(spec.group_by ? { group_by: spec.group_by } : {}), ...(compare === undefined ? {} : { compare }) });
  await save(exec, record, { step: step.id, status: "done", started_at: startedAt, input_fingerprint: fingerprint(list), output });
  return { kind: "done", output, actions: 0, needs_human: 0 };
}
