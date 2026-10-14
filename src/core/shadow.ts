import { ToolRefusal, deciderFor } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { listOutbox } from "./outbound.js";
import { PACKS_FILE, checkPacks, loadPacks, savePacks, type Candidate, type Packs } from "./packs.js";
import { startRun } from "./runner.js";
import { parseSkillswikiRef } from "./skillswiki.js";
import { loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { invokeTool, toolContext } from "./tools.js";
import type { Roles } from "./types.js";
import { loadWorkflow, workflowIds, type Workflow } from "./workflow.js";

/**
 * The shadow upgrade (spec §14.3, D34, D108). A candidate pack version (D107) is tried before anyone relies on it:
 * each workflow whose judges read that pack runs twice in sandbox, on the pinned text and on the candidate (a shadow
 * run), so nothing is sent or changed. The two runs are compared (status, actions, recordings, answers that need a
 * person) and every `ShadowEval` grades the comparison. v1 has one eval, `shadow-runs`: Skills Wiki's hosted evals
 * (`eval_start` … `eval_submit`) need a model to answer and grade tasks in a conversation and cannot run unattended
 * yet (O11), and the test double has none. A passing candidate is announced to the decision maker; only they switch,
 * in their own terminal (a policy change). Every step is audited.
 */
export interface ShadowSide {
  readonly run_id: string;
  readonly status: string;
  readonly actions: number;
  readonly recorded: number;
  readonly needs_human: number;
}

export interface ShadowComparison {
  readonly workflow: string;
  readonly pinned: ShadowSide;
  readonly candidate: ShadowSide;
}

export interface EvalResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** A way to grade a candidate from its shadow runs; hosted evals would be another one (O11). */
export interface ShadowEval {
  readonly name: string;
  readonly evaluate: (comparisons: readonly ShadowComparison[]) => Promise<EvalResult>;
}

export interface ShadowResult {
  readonly at: string;
  readonly version: string;
  readonly comparisons: readonly ShadowComparison[];
  readonly evals: readonly EvalResult[];
  readonly passed: boolean;
}

/** Passes when every candidate run completed and none needs a person more often than the pinned version's run. */
export const SHADOW_RUNS_EVAL: ShadowEval = {
  name: "shadow-runs",
  evaluate: async (comparisons) => {
    const worse = comparisons.filter(({ pinned, candidate }) => candidate.status !== "completed" || candidate.needs_human > pinned.needs_human);
    const detail = worse.length > 0 ? `worse on the candidate: ${worse.map(({ workflow, candidate }) => `${workflow} (${candidate.status}, ${candidate.needs_human} need a person)`).join(", ")}`
      : comparisons.length === 0 ? "no workflow reads this pack" : `${comparisons.length} workflow(s) did as well on the candidate`;
    return { name: "shadow-runs", passed: worse.length === 0, detail };
  },
};

async function workflowsUsing(home: string, pack: string): Promise<Workflow[]> {
  const found: Workflow[] = [];
  for (const id of await workflowIds(home)) {
    try {
      const workflow = await loadWorkflow(home, id, DEFAULT_TOOLS);
      if (workflow.steps.some((step) => step.kind === "judge" && step.judge.skill !== undefined && parseSkillswikiRef(step.judge.skill).pack === pack)) found.push(workflow);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return found;
}

/** One sandbox run with its own key (the same key again returns the same run, so a shadow is never run twice). */
async function side(home: string, workflow: Workflow, key: string, now: () => string, shadow?: string): Promise<ShadowSide> {
  const record = await startRun({ home, workflow, key, trigger: { kind: "manual" }, now, sandbox: true, ...(shadow ? { shadow } : {}) });
  const recorded = (await listOutbox(home, `${workflow.id}/${record.run_id}`)).length;
  return { run_id: record.run_id, status: record.status, actions: record.actions, recorded, needs_human: record.needs_human };
}

async function saveShadow(home: string, pack: string, result: ShadowResult): Promise<void> {
  const packs = await loadPacks(home);
  const pin = packs[pack];
  if (pin?.candidate?.version !== result.version) return;
  await savePacks(home, { ...packs, [pack]: { ...pin, candidate: { ...pin.candidate, shadow: result } } });
}

/** A passing candidate is announced to the decision maker (L1; R6 and the kill switch apply); a failed send is audited. */
async function announce(home: string, pack: string, result: ShadowResult, now: () => string): Promise<void> {
  const text = `Skills Wiki pack '${pack}' has a new version and its shadow runs passed (${result.comparisons.length} workflow(s); nothing was sent or changed). The pinned version stays in use until you run 'taskfollow packs switch ${pack} --as <your name>' in your own terminal.`;
  const name = (await loadState(home))?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(await toolContext(home, "runner", DEFAULT_TOOLS, now), "channel.notify", { member: name, text });
    } catch (failure) {
      if (!(failure instanceof InputError || failure instanceof ToolRefusal || failure instanceof ActionFailure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(home, { ts: now(), actor: "engine", event: "pack.announced", ref: `pack:${pack}`, payload: { version: result.version, delivered: error === null, ...(error ? { error } : {}) } });
}

/** Runs the shadow of a pack's candidate, grades it, keeps the result with the candidate and announces a pass. */
export async function shadowPack(home: string, pack: string, now: () => string, evals: readonly ShadowEval[] = [SHADOW_RUNS_EVAL]): Promise<ShadowResult> {
  const candidate = (await loadPacks(home))[pack]?.candidate;
  if (!candidate) throw new InputError(`Pack '${pack}' has no new version to try: run 'taskfollow packs check' first`);
  const comparisons: ShadowComparison[] = [];
  for (const workflow of await workflowsUsing(home, pack)) {
    const key = `${workflow.id}:shadow:${pack}:${candidate.version.slice(0, 12)}`;
    comparisons.push({ workflow: workflow.id, pinned: await side(home, workflow, `${key}:pinned`, now), candidate: await side(home, workflow, `${key}:candidate`, now, pack) });
  }
  const graded: EvalResult[] = [];
  for (const shadowEval of evals) graded.push(await shadowEval.evaluate(comparisons));
  const result: ShadowResult = { at: now(), version: candidate.version, comparisons, evals: graded, passed: graded.every((entry) => entry.passed) };
  await saveShadow(home, pack, result);
  await appendAudit(home, { ts: now(), actor: "engine", event: "pack.shadow_ran", ref: `pack:${pack}`, payload: { version: candidate.version, passed: result.passed, workflows: comparisons.map((entry) => entry.workflow) } });
  if (result.passed) await announce(home, pack, result, now);
  return result;
}

async function refuseSwitch(home: string, pack: string, by: string, reason: string, now: string): Promise<never> {
  await appendAudit(home, { ts: now, actor: by === "agent" ? "agent" : "human", event: "pack.switch_refused", ref: `pack:${pack}`, payload: { by, reason } });
  throw new InputError(reason);
}

/** The decision maker, in their own terminal, after a passing shadow of this very candidate: the candidate becomes the pin. */
export async function switchPack(home: string, pack: string, roles: Roles | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (!person.interactive) return refuseSwitch(home, pack, "agent", `Switching a pack version is the decision maker's call, in their own terminal: 'taskfollow packs switch ${pack} --as <their name>'`, now());
  const decider = deciderFor(person.as, roles);
  if (decider.role !== "decision_maker") return refuseSwitch(home, pack, decider.name, "Switching a pack version is a policy change: only the decision maker switches (--as <their name>)", now());
  const packs: Packs = await loadPacks(home);
  const pin = packs[pack];
  const candidate: Candidate | undefined = pin?.candidate;
  if (!pin || !candidate) throw new InputError(`Pack '${pack}' has no new version: 'taskfollow packs list' shows the pins`);
  if (candidate.shadow?.version !== candidate.version || !candidate.shadow.passed) throw new InputError(`The shadow runs of '${pack}' have not passed for this version: run 'taskfollow packs shadow ${pack}' and read the comparison`);
  const { candidate: _done, ...kept } = pin;
  await savePacks(home, { ...packs, [pack]: { ...kept, version: candidate.version, files: candidate.files, pinned_at: now() } });
  await appendAudit(home, { ts: now(), actor: "human", event: "pack.switched", ref: `pack:${pack}`, payload: { from: pin.version, to: candidate.version, by: decider.name } });
  return { status: "switched", pack, from: pin.version, to: candidate.version, by: decider.name };
}

const summary = (packs: Packs) =>
  Object.entries(packs).map(([pack, pin]) => ({
    pack, version: pin.version, files: Object.keys(pin.files), pinned_at: pin.pinned_at,
    ...(pin.candidate ? { candidate: { version: pin.candidate.version, found_at: pin.candidate.found_at, shadow: pin.candidate.shadow ? { at: pin.candidate.shadow.at, passed: pin.candidate.shadow.passed, evals: pin.candidate.shadow.evals } : null } } : {}),
  }));

/** `taskfollow packs [list | check | shadow <pack> | switch <pack> --as <name>]` (D107, D108). */
export async function packsCommand(home: string, sub: string | undefined, pack: string | undefined, roles: Roles | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "list") return { packs: summary(await loadPacks(home)), file: PACKS_FILE };
  if (sub === "check") return { updates: await checkPacks(home, (await loadState(home))?.skillswiki?.url, now()) };
  if ((sub === "shadow" || sub === "switch") && pack) return sub === "shadow" ? { ...(await shadowPack(home, pack, now)) } : switchPack(home, pack, roles, person, now);
  throw new InputError("packs takes: list, check, shadow <pack>, switch <pack> --as <name>");
}
