import { join } from "node:path";
import { appendAudit, canonicalJson } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { interpolate } from "./expressions.js";
import { InputError } from "./inputs.js";
import { listRuns, loadStep, type AgentTurn, type RunRecord } from "./runs.js";
import { saveWorkflowState } from "./sandbox.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { WORKFLOWS_DIR, WORKFLOW_FILE, loadWorkflow, parseWorkflow, requireWorkflowId, type AgentSpec, type Workflow } from "./workflow.js";

/**
 * Hardening (spec §10.8, D93). The runner reads the agent step's calls in the last HARDEN_RUNS completed runs of the
 * current version; the calls at the start that are the same tool in every run, with every argument either the same
 * value or found at the same path of the run's data or of an earlier call's result, become typed `tool` steps
 * (`call_<n>`). What remains stays with the agent; a version with nothing left is typed, and keeps the agent as
 * its `fallback` for drift. Before a person applies it, the replay gate runs the new steps over the last
 * REPLAY_RUNS runs with their recorded results: every call must come out exactly as the agent made it. The old
 * version is kept under `workflows/<id>/versions/<n>/`. A typed step goes through the same gate: hardening never
 * changes a level or skips an approval.
 */
export const HARDEN_RUNS = 5;
export const REPLAY_RUNS = 10;
export const VERSIONS_DIR = "versions";
const MAX_DEPTH = 6;
const ROOT = /^[a-z_][a-z0-9_]*$/i;
const NAME = /^[a-z0-9_]+$/i;

type Raw = Record<string, unknown>;
type ToolStep = { readonly id: string; readonly tool: string; readonly args: Readonly<Record<string, unknown>> };

export interface Proposal {
  readonly workflow: string;
  readonly from_version: number;
  readonly promoted: readonly ToolStep[];
  /** True when some calls still need the agent's judgment, so the new version ends with the agent step. */
  readonly agent_kept: boolean;
  readonly based_on: readonly string[];
}

export interface Replay {
  readonly ok: boolean;
  readonly runs: readonly { readonly run_id: string; readonly ok: boolean; readonly mismatch?: string }[];
}

interface Sample {
  readonly run: RunRecord;
  readonly input: Raw;
  readonly turns: readonly AgentTurn[];
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Every path inside `within` whose value equals `value` (paths in the workflow expression language). */
function pathsTo(value: unknown, within: unknown, prefix: string, depth = 0): string[] {
  const here = prefix !== "" && same(within, value) ? [prefix] : [];
  if (depth >= MAX_DEPTH || typeof within !== "object" || within === null) return here;
  const children: [string, unknown][] = Array.isArray(within)
    ? within.slice(0, 50).map((entry, index) => [`${prefix}[${index}]`, entry])
    : Object.entries(within).filter(([key]) => (prefix === "" ? ROOT : NAME).test(key)).map(([key, entry]) => [prefix === "" ? key : `${prefix}.${key}`, entry]);
  return [...here, ...children.flatMap(([path, entry]) => pathsTo(value, entry, path, depth + 1))];
}

/** One argument across the samples: the same literal everywhere, or one path that holds it in every run, or null. */
function explain(values: readonly unknown[], scopes: readonly Raw[]): unknown {
  const first = values[0];
  if (values.every((value) => same(value, first))) return typeof first === "string" && first.includes("${") ? null : first;
  const paths = pathsTo(first, scopes[0], "").filter((path) => scopes.every((scope, index) => pathsTo(values[index], scope, "").includes(path)));
  return paths[0] === undefined ? null : `\${${paths[0]}}`;
}

/** The call at `index` as a tool step, when every run made it the same way; null when it needs judgment. */
function promote(samples: readonly Sample[], scopes: readonly Raw[], index: number, id: string): ToolStep | null {
  const turns = samples.map((sample) => sample.turns[index]);
  if (turns.some((turn) => !turn || turn.error !== undefined || turn.result === undefined || turn.tool !== turns[0]?.tool)) return null;
  const keys = Object.keys(turns[0]?.args ?? {}).sort();
  if (turns.some((turn) => !same(Object.keys(turn?.args ?? {}).sort(), keys))) return null;
  const args: Record<string, unknown> = {};
  for (const key of keys) {
    const template = explain(turns.map((turn) => turn?.args[key]), scopes);
    if (template === null) return null;
    args[key] = template;
  }
  return { id, tool: turns[0]?.tool ?? "", args };
}

const agentOf = (workflow: Workflow): (AgentSpec & { readonly id: string }) | null => {
  const last = workflow.steps.at(-1);
  return last?.kind === "agent" && last.agent.input === undefined ? { ...last.agent, id: last.id } : null;
};

async function samples(home: string, workflow: Workflow, count: number): Promise<Sample[]> {
  const agent = agentOf(workflow);
  if (!agent) return [];
  const runs = (await listRuns(home, workflow.id)).filter((run) => run.status === "completed" && !run.sandbox && run.version === workflow.version && !run.fallback_from);
  const found: Sample[] = [];
  for (const run of runs.slice(-count)) {
    const log = await loadStep(home, run, agent.id);
    if (log?.turns && typeof log.input === "object" && log.input !== null) found.push({ run, input: log.input as Raw, turns: log.turns });
  }
  return found;
}

/** §10.8 proposal rule; `reason` says why there is none. */
export async function proposeHardening(home: string, workflow: Workflow): Promise<Proposal | { readonly reason: string }> {
  if (!agentOf(workflow)) return { reason: `workflow '${workflow.id}' has no agent step at its end (with its default input) to harden` };
  const found = await samples(home, workflow, HARDEN_RUNS);
  if (found.length < HARDEN_RUNS) return { reason: `${found.length} completed runs of version ${workflow.version}; hardening needs ${HARDEN_RUNS}` };
  const scopes = found.map((sample) => ({ ...sample.input }));
  const promoted: ToolStep[] = [];
  const offset = workflow.steps.length - 1;
  for (let index = 0; index < Math.min(...found.map((sample) => sample.turns.length)); index += 1) {
    const step = promote(found, scopes, index, `call_${offset + index + 1}`);
    if (!step) break;
    promoted.push(step);
    found.forEach((sample, at) => Object.assign(scopes[at] as Raw, { [step.id]: sample.turns[index]?.result }));
  }
  if (promoted.length === 0) return { reason: "the agent's first call already needs judgment in these runs (or differs between them)" };
  const agentKept = found.some((sample) => sample.turns.length > promoted.length);
  return { workflow: workflow.id, from_version: workflow.version, promoted, agent_kept: agentKept, based_on: found.map((sample) => sample.run.run_id) };
}

/** Runs the new steps over recorded runs: each call must equal the agent's own call; its recorded result stands in. */
export async function replayGate(home: string, workflow: Workflow, proposal: Proposal): Promise<Replay> {
  const runs = [];
  for (const sample of await samples(home, workflow, REPLAY_RUNS)) {
    const scope: Raw = { ...sample.input };
    let mismatch: string | undefined;
    for (const [index, step] of proposal.promoted.entries()) {
      const turn = sample.turns[index];
      let args: unknown;
      try {
        args = interpolate(step.args, scope);
      } catch (error) {
        args = (error as Error).message;
      }
      if (!turn || turn.tool !== step.tool || !same(args, turn.args)) {
        mismatch = `${step.id}: the agent called ${turn ? `${turn.tool} ${canonicalJson(turn.args)}` : "nothing"}, the new step would call ${step.tool} ${canonicalJson(args)}`;
        break;
      }
      scope[step.id] = turn.result;
    }
    if (!mismatch && !proposal.agent_kept && sample.turns.length !== proposal.promoted.length) mismatch = `the agent made ${sample.turns.length} calls; the typed version makes ${proposal.promoted.length}`;
    runs.push({ run_id: sample.run.run_id, ok: mismatch === undefined, ...(mismatch ? { mismatch } : {}) });
  }
  return { ok: runs.length >= HARDEN_RUNS && runs.every((run) => run.ok), runs };
}

const fileOf = (id: string): string => join(WORKFLOWS_DIR, id, WORKFLOW_FILE);
const versionFile = (id: string, version: number): string => join(WORKFLOWS_DIR, id, VERSIONS_DIR, String(version), WORKFLOW_FILE);

/**
 * Keeps the current file under versions/<n>/ and writes `next` (checked first) as the workflow. The new version
 * goes back to sandbox, with no dry run: it runs live only once a person confirmed a dry run of it (D98).
 */
async function replaceVersion(home: string, workflow: Workflow, next: Raw): Promise<Workflow> {
  const checked = parseWorkflow(next, workflow.id, DEFAULT_TOOLS);
  await writeConfig(home, versionFile(workflow.id, workflow.version), await readConfig(home, fileOf(workflow.id)));
  await saveWorkflowState(home, { workflow: workflow.id, sandbox: true });
  await writeConfig(home, fileOf(workflow.id), next);
  return checked;
}

const dryRunNext = (id: string, version: number): string => `Version ${version} runs in sandbox until a person confirms a dry run of it: 'taskfollow dryrun ${id}', then 'taskfollow dryrun confirm ${id}'`;

function hardenedFile(workflow: Workflow, current: Raw, proposal: Proposal): Raw {
  const agent = agentOf(workflow) as AgentSpec & { readonly id: string };
  const spec = { instructions: agent.instructions, tools: agent.tools, max_turns: agent.max_turns };
  const kept = current.mode === "agentic" ? [] : (current.steps as unknown[]).slice(0, -1);
  const steps = [...kept, ...proposal.promoted, ...(proposal.agent_kept ? [{ id: agent.id, agent: spec }] : [])];
  return { workflow: workflow.id, version: workflow.version + 1, description: workflow.description, mode: "typed", ...(current.trigger === undefined ? {} : { trigger: current.trigger }), steps, fallback: spec, ...(Array.isArray(current.skills) && current.skills.length > 0 ? { skills: current.skills } : {}) };
}

/** Applies the proposal once the replay gate passed: a person's decision, in their own terminal (§10.8 "human approves"). */
export async function applyHardening(home: string, workflow: Workflow, by: string, now: string): Promise<Record<string, unknown>> {
  const proposal = await proposeHardening(home, workflow);
  if ("reason" in proposal) throw new InputError(`Nothing to harden: ${proposal.reason}`);
  const replay = await replayGate(home, workflow, proposal);
  if (!replay.ok) throw new InputError(`The replay gate failed, so version ${workflow.version} stays: ${replay.runs.filter((run) => !run.ok).map((run) => `${run.run_id}: ${run.mismatch ?? ""}`).join("; ")}`);
  const next = await replaceVersion(home, workflow, hardenedFile(workflow, (await readConfig(home, fileOf(workflow.id))) as Raw, proposal));
  await appendAudit(home, { ts: now, actor: "human", event: "workflow.hardened", ref: `workflow:${workflow.id}`, payload: { by, from: workflow.version, to: next.version, promoted: proposal.promoted.map((step) => step.tool), replayed: replay.runs.length } });
  return { status: "hardened", workflow: workflow.id, version: next.version, kept: join(WORKFLOWS_DIR, workflow.id, VERSIONS_DIR, String(workflow.version)), promoted: proposal.promoted, agent_kept: proposal.agent_kept, sandbox: true, next: dryRunNext(workflow.id, next.version) };
}

/** Restores version `version` from versions/ as a new version (versions only grow, so run keys never repeat). */
export async function rollbackWorkflow(home: string, workflow: Workflow, version: number, by: string, now: string): Promise<Record<string, unknown>> {
  const old = await readConfig(home, versionFile(workflow.id, version));
  if (old === null || typeof old !== "object") throw new InputError(`Workflow '${workflow.id}' has no kept version ${version} under ${VERSIONS_DIR}/`);
  const next = await replaceVersion(home, workflow, { ...(old as Raw), version: workflow.version + 1 });
  await appendAudit(home, { ts: now, actor: "human", event: "workflow.rolled_back", ref: `workflow:${workflow.id}`, payload: { by, from: workflow.version, restored: version, to: next.version } });
  return { status: "rolled_back", workflow: workflow.id, restored: version, version: next.version, sandbox: true, next: dryRunNext(workflow.id, next.version) };
}

/** `taskfollow harden <workflow> [apply | rollback --value <n>]`: shows the proposal and its replay; changes need a terminal. */
export async function hardenCommand(home: string, id: string | undefined, sub: string | undefined, extra: string | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  if (sub === undefined) {
    const proposal = await proposeHardening(home, workflow);
    if ("reason" in proposal) return { workflow: workflow.id, version: workflow.version, proposal: null, reason: proposal.reason };
    return { workflow: workflow.id, version: workflow.version, proposal, replay: await replayGate(home, workflow, proposal), next: `A person applies it with 'taskfollow harden ${workflow.id} apply' in their own terminal` };
  }
  if (!person.interactive) throw new InputError("Changing a workflow's version is a person's decision: run it in your own terminal, not through the agent");
  const by = person.as?.trim() || "terminal";
  if (sub === "apply") return applyHardening(home, workflow, by, now());
  if (sub === "rollback" && extra !== undefined && /^[1-9]\d*$/.test(extra)) return rollbackWorkflow(home, workflow, Number(extra), by, now());
  throw new InputError("harden takes: taskfollow harden <workflow> [apply | rollback --value <version>]");
}
