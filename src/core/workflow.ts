import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { confinedPath } from "./actions.js";
import { isTimeZone, parseCron } from "./cron.js";
import { conditionRoots, parseCondition, templateRoots } from "./expressions.js";
import { InputError } from "./inputs.js";
import { checkSchema } from "./json-schema.js";
import type { ToolRegistry } from "./tools.js";

/**
 * Workflow files (spec §10.1, D81): `workflows/<id>/workflow.json` under the engine home, JSON like every other
 * engine file (no YAML parser: zero runtime dependencies). Steps are typed (§10.2, D14): `tool` calls one tool of
 * the registry, `judge` asks the model for JSON that fits a schema and never acts, `approve` asks a person to
 * approve one exact tool call and runs it once approved. `foreach` and `when` modify a step. Everything is
 * checked when the file is loaded: tools exist, references name earlier steps, conditions parse, schemas use
 * only what the runner can check. Nothing in a workflow can choose a level or carry an approval token.
 * Plan 8 (§10.8, D92): an `agent` step lets the model choose each call among the step's tools, one at a time, and the
 * runner makes it through the gate; `mode: "agentic"` is a workflow that is one agent step (instructions + tools),
 * and a typed workflow may name a `fallback` agent that finishes a run whose typed step failed (drift, §10.9).
 */
export const WORKFLOWS_DIR = "workflows";
export const WORKFLOW_FILE = "workflow.json";
export const DEFAULT_TOLERANCE_MINUTES = 5;
export const DEFAULT_MAX_TOOL_CALLS = 3;
export const DEFAULT_MAX_TURNS = 8;
export const MAX_TURNS = 20;
export const DEFAULT_TASK_MINUTES = 10;
export const MAX_TASK_MINUTES = 30;
/** A workflow's skills (9.12 item 2): the workflow's own skill folder first, then up to 9 the person confirmed. */
export const MAX_WORKFLOW_SKILLS = 10;
/** The id of the one step of an agentic workflow, and of the step a drifting run falls back to. */
export const AGENT_STEP = "agent";
export const FALLBACK_STEP = "fallback";
const ID = /^[a-z0-9][a-z0-9-]*$/;
const STEP_ID = /^[a-z][a-z0-9_]*$/;
/** Names the runner binds itself; a step cannot be called one of them. */
const RESERVED = ["item", "event", "run", "failure", "previous", FALLBACK_STEP];
const FROM = ["external", "member"] as const;

export type Trigger =
  | { readonly kind: "cron"; readonly cron: string; readonly tz: string; readonly tolerance_minutes: number }
  | { readonly kind: "event"; readonly event: "message.received"; readonly from: (typeof FROM)[number]; readonly channel?: string }
  | { readonly kind: "manual" };

/** A step's arguments: an object of templates, or one whole reference to an object an earlier step produced. */
export type ArgsTemplate = Readonly<Record<string, unknown>> | string;

export interface ContextTool {
  readonly tool: string;
  readonly args: ArgsTemplate;
}

export interface JudgeSpec {
  readonly instructions: string;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly input?: unknown;
  readonly skill?: string;
  readonly context_tools: readonly ContextTool[];
  readonly max_tool_calls: number;
  readonly min_confidence?: number;
}
/** An agentic step (§10.8): the model names each call among `tools`; the runner makes it through the gate. */
export interface AgentSpec {
  readonly instructions: string;
  readonly tools: readonly string[];
  readonly max_turns: number;
  readonly input?: unknown;
}

/** A task step (D139): the person's own agent does the work with its own tools, limited to `may_use`, under the hook. */
export interface TaskSpec {
  readonly prompt: string;
  readonly input?: unknown;
  /** Claude Code permission rules: `mcp__<server>`, `mcp__<server>__<tool>` (a trailing * allowed), `Bash(<command>:*)`. */
  readonly may_use: readonly string[];
  /** Whether the task may change things; false means read only (the hook refuses known write flags). */
  readonly changes: boolean;
  readonly output: Readonly<Record<string, unknown>>;
  readonly timeout_minutes: number;
}

/** A calc step (D144): arithmetic on a list an earlier step produced; `compare` is usually `${previous.<step>}`. */
export interface CalcStepSpec {
  readonly from: string;
  readonly group_by?: string;
  readonly sum: readonly string[];
  readonly compare?: string;
}

interface StepBase {
  readonly id: string;
  readonly when?: string;
}

export type WorkflowStep =
  | (StepBase & { readonly kind: "tool"; readonly tool: string; readonly args: ArgsTemplate; readonly foreach?: string })
  | (StepBase & { readonly kind: "judge"; readonly judge: JudgeSpec; readonly foreach?: string })
  | (StepBase & { readonly kind: "approve"; readonly tool: string; readonly args: ArgsTemplate; readonly why: string; readonly urgent: boolean })
  | (StepBase & { readonly kind: "agent"; readonly agent: AgentSpec })
  | (StepBase & { readonly kind: "task"; readonly task: TaskSpec })
  | (StepBase & { readonly kind: "calc"; readonly calc: CalcStepSpec });

export interface Workflow {
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly mode: "typed" | "agentic";
  readonly trigger: Trigger;
  readonly steps: readonly WorkflowStep[];
  /** The agent a run falls back to when one of its typed steps fails (drift, D18). */
  readonly fallback?: AgentSpec;
  /** Skills every run's prompt gets (9.12 item 2, D153): local skill folders (absolute paths) or `skillswiki:` refs. */
  readonly skills: readonly string[];
}

export class WorkflowError extends InputError {
  constructor(id: string, message: string) {
    super(`Workflow '${id}': ${message}`);
    this.name = "WorkflowError";
  }
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string, fail: (message: string) => never): string {
  if (typeof value !== "string" || value.trim() === "") return fail(`${where} must be non-empty text`);
  return value.trim();
}

function parseTrigger(value: unknown, fail: (message: string) => never): Trigger {
  if (value === undefined || (isRecord(value) && value.manual === true)) return { kind: "manual" };
  if (!isRecord(value)) return fail("trigger must be an object");
  if (value.cron !== undefined) {
    const cron = text(value.cron, "trigger.cron", fail);
    try {
      parseCron(cron);
    } catch (error) {
      return fail((error as Error).message);
    }
    const tz = text(value.tz, "trigger.tz (an IANA time zone, for example America/Toronto)", fail);
    if (!isTimeZone(tz)) return fail(`trigger.tz '${tz}' is not an IANA time zone`);
    const tolerance = value.tolerance_minutes ?? DEFAULT_TOLERANCE_MINUTES;
    if (typeof tolerance !== "number" || !Number.isInteger(tolerance) || tolerance < 1 || tolerance > 60) return fail("trigger.tolerance_minutes must be a whole number from 1 to 60");
    return { kind: "cron", cron, tz, tolerance_minutes: tolerance };
  }
  if (value.event !== "message.received") return fail('trigger must be {"cron":…,"tz":…}, {"event":"message.received","from":"external"|"member"} or {"manual":true}');
  if (!(FROM as readonly unknown[]).includes(value.from)) return fail(`trigger.from must be one of ${FROM.join(", ")}`);
  const channel = value.channel === undefined ? {} : { channel: text(value.channel, "trigger.channel", fail) };
  return { kind: "event", event: "message.received", from: value.from as (typeof FROM)[number], ...channel };
}

function args(value: unknown, where: string, fail: (message: string) => never): ArgsTemplate {
  if (value === undefined) return {};
  if (typeof value === "string" && /^\$\{[^}]*\}$/.test(value)) return value;
  if (!isRecord(value)) return fail(`${where} must be an object, or one reference such as "\${draft}"`);
  if (Object.hasOwn(value, "approval_token")) return fail(`${where} cannot carry an approval_token: the runner asks for approvals itself`);
  return value;
}

function workflowTool(registry: ToolRegistry, name: unknown, where: string, fail: (message: string) => never): string {
  const tool = typeof name === "string" ? registry.get(name) : undefined;
  if (!tool) return fail(`${where} names no known tool: ${[...registry.keys()].join(", ")}`);
  if (tool.meta) return fail(`${where}: ${tool.name} is approval bookkeeping; use an approve step instead`);
  return tool.name;
}

function parseContextTools(value: unknown, registry: ToolRegistry, where: string, fail: (message: string) => never): readonly ContextTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail(`${where}.context_tools must be a list`);
  return value.map((entry, index) => {
    const at = `${where}.context_tools[${index}]`;
    if (!isRecord(entry)) return fail(`${at} must be {"tool":…,"args":…}`);
    const tool = workflowTool(registry, entry.tool, at, fail);
    if (registry.get(tool)?.level !== "L0") return fail(`${at}: ${tool} is not a read-only (L0) tool; a judge may only read`);
    return { tool, args: args(entry.args, `${at}.args`, fail) };
  });
}

function parseJudge(value: unknown, registry: ToolRegistry, where: string, fail: (message: string) => never): JudgeSpec {
  if (!isRecord(value)) return fail(`${where} must be an object`);
  try {
    checkSchema(value.schema, `${where}.schema`);
  } catch (error) {
    return fail((error as Error).message);
  }
  const budget = value.max_tool_calls ?? DEFAULT_MAX_TOOL_CALLS;
  if (typeof budget !== "number" || !Number.isInteger(budget) || budget < 0 || budget > 10) return fail(`${where}.max_tool_calls must be a whole number from 0 to 10`);
  const contextTools = parseContextTools(value.context_tools, registry, where, fail);
  if (contextTools.length > budget) return fail(`${where} lists ${contextTools.length} context tools but allows ${budget} calls (max_tool_calls)`);
  const minimum = value.min_confidence;
  if (minimum !== undefined && (typeof minimum !== "number" || minimum < 0 || minimum > 1)) return fail(`${where}.min_confidence must be a number from 0 to 1`);
  const skill = value.skill === undefined ? undefined : text(value.skill, `${where}.skill`, fail);
  if (skill !== undefined && !skill.startsWith("skillswiki:")) return fail(`${where}.skill must be skillswiki:<pack>/<skill>/<path>`);
  return {
    instructions: text(value.instructions, `${where}.instructions`, fail), schema: value.schema as Raw, context_tools: contextTools, max_tool_calls: budget,
    ...(value.input === undefined ? {} : { input: value.input }), ...(skill ? { skill } : {}), ...(minimum === undefined ? {} : { min_confidence: minimum as number }),
  };
}
function parseAgent(value: unknown, registry: ToolRegistry, where: string, fail: (message: string) => never): AgentSpec {
  if (!isRecord(value)) return fail(`${where} must be {"instructions":…,"tools":[…]}`);
  if (!Array.isArray(value.tools) || value.tools.length === 0) return fail(`${where}.tools must list the tools the agent may call`);
  const tools = [...new Set(value.tools.map((name, index) => workflowTool(registry, name, `${where}.tools[${index}]`, fail)))];
  const turns = value.max_turns ?? DEFAULT_MAX_TURNS;
  if (typeof turns !== "number" || !Number.isInteger(turns) || turns < 1 || turns > MAX_TURNS) return fail(`${where}.max_turns must be a whole number from 1 to ${MAX_TURNS}`);
  return { instructions: text(value.instructions, `${where}.instructions`, fail), tools, max_turns: turns, ...(value.input === undefined ? {} : { input: value.input }) };
}

const MCP_RULE = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_.-]+\*?)?$/;
const BASH_RULE = /^Bash\(([^;&|`<>$\n\r*]+)(:\*)?\)$/;

/** A Claude Code permission rule for one tool or server: `mcp__<server>[__<tool>]` or `Bash(<command>[:*])`. */
export const isToolRule = (rule: string): boolean => MCP_RULE.test(rule) || BASH_RULE.test(rule);

function parseMayUse(value: unknown, where: string, fail: (message: string) => never): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) return fail(`${where}.may_use must list the tools the agent may use`);
  return value.map((rule, index) => {
    const at = `${where}.may_use[${index}]`;
    if (typeof rule !== "string" || !(MCP_RULE.test(rule) || BASH_RULE.test(rule))) {
      return fail(`${at} must be mcp__<server>, mcp__<server>__<tool>, or Bash(...) with a command, for example Bash(shopify store execute:*)`);
    }
    if (rule.startsWith("mcp__installer")) return fail(`${at}: TaskFollow's own tools are used through tool and approve steps, not by a task`);
    return rule;
  });
}

function parseTask(value: unknown, where: string, fail: (message: string) => never): TaskSpec {
  if (!isRecord(value)) return fail(`${where} must be {"prompt":…,"may_use":[…],"output":{…}}`);
  try {
    checkSchema(value.output, `${where}.output`);
  } catch (error) {
    return fail((error as Error).message);
  }
  const minutes = value.timeout_minutes ?? DEFAULT_TASK_MINUTES;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TASK_MINUTES) return fail(`${where}.timeout_minutes must be a whole number from 1 to ${MAX_TASK_MINUTES}`);
  if (value.changes !== undefined && typeof value.changes !== "boolean") return fail(`${where}.changes must be true or false`);
  return {
    prompt: text(value.prompt, `${where}.prompt`, fail), may_use: parseMayUse(value.may_use, where, fail), changes: value.changes === true,
    output: value.output as Raw, timeout_minutes: minutes, ...(value.input === undefined ? {} : { input: value.input }),
  };
}

const FIELD = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const ONE_REFERENCE = /^\$\{[^}]*\}$/;

function parseCalc(value: unknown, where: string, fail: (message: string) => never): CalcStepSpec {
  if (!isRecord(value)) return fail(`${where} must be {"from":"\${step.list}","sum":["field"]}`);
  if (typeof value.from !== "string" || !ONE_REFERENCE.test(value.from)) return fail(`${where}.from must be one reference to a list, for example "\${orders.orders}"`);
  if (!Array.isArray(value.sum) || value.sum.length === 0 || !value.sum.every((field) => typeof field === "string" && FIELD.test(field))) return fail(`${where}.sum must list the fields to add up, for example ["total"]`);
  if (value.group_by !== undefined && (typeof value.group_by !== "string" || !FIELD.test(value.group_by))) return fail(`${where}.group_by must be a field name`);
  if (value.compare !== undefined && (typeof value.compare !== "string" || !ONE_REFERENCE.test(value.compare))) return fail(`${where}.compare must be one reference, for example "\${previous.totals}"`);
  return { from: value.from, sum: value.sum as string[], ...(value.group_by === undefined ? {} : { group_by: value.group_by as string }), ...(value.compare === undefined ? {} : { compare: value.compare as string }) };
}

function parseStep(value: unknown, index: number, registry: ToolRegistry, fail: (message: string) => never): WorkflowStep {
  const where = `steps[${index}]`;
  if (!isRecord(value)) return fail(`${where} must be an object`);
  const id = typeof value.id === "string" && STEP_ID.test(value.id) && !RESERVED.includes(value.id) ? value.id : fail(`${where}.id must be lowercase letters, digits and _ (not ${RESERVED.join(", ")})`);
  const kinds = ["tool", "judge", "approve", "agent", "task", "calc"].filter((kind) => value[kind] !== undefined);
  if (kinds.length !== 1) return fail(`step '${id}' must have exactly one of tool, judge, approve, agent, task, calc`);
  const base = { id, ...(value.when === undefined ? {} : { when: text(value.when, `step '${id}'.when`, fail) }) };
  const foreach = value.foreach === undefined ? {} : { foreach: text(value.foreach, `step '${id}'.foreach`, fail) };
  if (value.judge !== undefined) return { ...base, kind: "judge", judge: parseJudge(value.judge, registry, `step '${id}'.judge`, fail), ...foreach };
  if (value.tool !== undefined) return { ...base, kind: "tool", tool: workflowTool(registry, value.tool, `step '${id}'`, fail), args: args(value.args, `step '${id}'.args`, fail), ...foreach };
  if (value.foreach !== undefined) return fail(`step '${id}': an ${kinds[0]} step cannot use foreach`);
  if (value.agent !== undefined) return { ...base, kind: "agent", agent: parseAgent(value.agent, registry, `step '${id}'.agent`, fail) };
  if (value.task !== undefined) return { ...base, kind: "task", task: parseTask(value.task, `step '${id}'.task`, fail) };
  if (value.calc !== undefined) return { ...base, kind: "calc", calc: parseCalc(value.calc, `step '${id}'.calc`, fail) };
  const approve = isRecord(value.approve) ? value.approve : fail(`step '${id}'.approve must be {"tool":…,"args":…,"why":…}`);
  return {
    ...base, kind: "approve", tool: workflowTool(registry, approve.tool, `step '${id}'.approve`, fail), args: args(approve.args, `step '${id}'.approve.args`, fail),
    why: text(approve.why, `step '${id}'.approve.why`, fail), urgent: approve.urgent === true,
  };
}

const foreachOf = (step: WorkflowStep): string | undefined => ("foreach" in step ? step.foreach : undefined);

/** The roots a step's arguments refer to; `item` is allowed there inside foreach. */
function argumentRoots(step: WorkflowStep): readonly string[] {
  if (step.kind === "agent") return templateRoots(step.agent.input);
  if (step.kind === "task") return templateRoots(step.task.input);
  if (step.kind === "calc") return templateRoots([step.calc.from, step.calc.compare ?? ""]);
  const templates = step.kind === "judge" ? [step.judge.input, step.judge.context_tools.map((entry) => entry.args)] : [step.args];
  return templates.flatMap(templateRoots);
}

/**
 * Every reference must name an earlier step, `run`, or `event` (event triggers); `item` only in the arguments of a
 * foreach step. `when` and `foreach` are read once per step, before any item, so they cannot use `item`.
 */
function checkReferences(workflow: Workflow, fail: (message: string) => never): void {
  // `previous`: the step outputs of this workflow's last finished run (D144), null before the first one.
  const seen: string[] = ["run", "previous", ...(workflow.trigger.kind === "event" ? ["event"] : [])];
  const unknownIn = (roots: readonly string[], allowed: readonly string[]): string | undefined => roots.find((root) => !allowed.includes(root));
  for (const step of workflow.steps) {
    if (seen.includes(step.id)) fail(`step id '${step.id}' is used twice`);
    const foreach = foreachOf(step);
    if (foreach !== undefined && !/^\$\{[^}]*\}$/.test(foreach)) fail(`step '${step.id}'.foreach must be one reference, for example "\${fetch.items}"`);
    const stepRoots = [...(foreach === undefined ? [] : templateRoots(foreach)), ...(step.when ? conditionRoots(parseCondition(step.when)) : [])];
    const unknown = unknownIn(stepRoots, seen) ?? unknownIn(argumentRoots(step), [...seen, ...(foreach === undefined ? [] : ["item"])]);
    if (unknown !== undefined) fail(`step '${step.id}' refers to '${unknown}', which is not an earlier step${unknown === "item" ? " (item exists only in the arguments of a foreach step)" : ""}`);
    seen.push(step.id);
  }
}
/** An agentic workflow (§10.8) is written as instructions and tools; it runs as one agent step. */
function rawSteps(value: Raw, fail: (message: string) => never): readonly unknown[] {
  if (value.mode !== "agentic") {
    if (!Array.isArray(value.steps) || value.steps.length === 0) return fail("steps must list at least one step");
    return value.steps;
  }
  if (value.steps !== undefined || value.fallback !== undefined) return fail("an agentic workflow has instructions and tools, not steps or a fallback: the agent chooses each call");
  const agent = { instructions: value.instructions, tools: value.tools, ...(value.max_turns === undefined ? {} : { max_turns: value.max_turns }), ...(value.input === undefined ? {} : { input: value.input }) };
  return [{ id: AGENT_STEP, agent }];
}

const SKILLSWIKI_REF = /^skillswiki:[^/]+\/[^/]+\/.+$/;

function parseSkills(value: unknown, fail: (message: string) => never): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return fail("skills must be a list of skill folders or skillswiki references");
  if (value.length > MAX_WORKFLOW_SKILLS) return fail(`skills must list at most ${MAX_WORKFLOW_SKILLS} skills`);
  const seen = new Set<string>();
  return value.map((ref, index) => {
    if (typeof ref !== "string" || !(SKILLSWIKI_REF.test(ref) || isAbsolute(ref))) return fail(`skills[${index}] must be a folder path from 'taskfollow skills' or skillswiki:<pack>/<skill>/<path>`);
    if (seen.has(ref)) return fail(`skills lists '${ref}' twice`);
    seen.add(ref);
    return ref;
  });
}

export function parseWorkflow(value: unknown, id: string, registry: ToolRegistry): Workflow {
  const fail = (message: string): never => {
    throw new WorkflowError(id, message);
  };
  if (!isRecord(value)) return fail("the file must be a JSON object");
  if (value.workflow !== id) return fail(`"workflow" must be '${id}', the name of its folder`);
  if (value.mode !== undefined && value.mode !== "typed" && value.mode !== "agentic") return fail('mode must be "typed" or "agentic"');
  const version = value.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return fail("version must be a whole number from 1");
  const fallback = value.fallback === undefined ? {} : { fallback: parseAgent(isRecord(value.fallback) ? { ...value.fallback, input: undefined } : value.fallback, registry, "fallback", fail) };
  const workflow: Workflow = {
    id, version, description: typeof value.description === "string" ? value.description : "", mode: value.mode === "agentic" ? "agentic" : "typed",
    trigger: parseTrigger(value.trigger, fail), steps: rawSteps(value, fail).map((step, index) => parseStep(step, index, registry, fail)), ...fallback,
    skills: parseSkills(value.skills, fail),
  };
  try {
    checkReferences(workflow, fail);
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    return fail((error as Error).message);
  }
  return workflow;
}

export function requireWorkflowId(id: string | undefined): string {
  if (!id || !ID.test(id)) throw new InputError("Name a workflow: lowercase letters, digits and dashes, for example: taskfollow run daily-digest");
  return id;
}

export async function loadWorkflow(home: string, id: string, registry: ToolRegistry): Promise<Workflow> {
  const path = await confinedPath(home, join(WORKFLOWS_DIR, requireWorkflowId(id), WORKFLOW_FILE));
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new InputError(`No workflow '${id}': ${join(WORKFLOWS_DIR, id, WORKFLOW_FILE)} does not exist in the home`);
    throw error;
  }
  try {
    return parseWorkflow(JSON.parse(raw) as unknown, id, registry);
  } catch (error) {
    if (error instanceof SyntaxError) throw new WorkflowError(id, `${WORKFLOW_FILE} is not valid JSON`);
    throw error;
  }
}

/** The ids of the workflows in the home, sorted. */
export async function workflowIds(home: string): Promise<string[]> {
  try {
    const names = await readdir(await confinedPath(home, WORKFLOWS_DIR), { withFileTypes: true });
    return names.filter((entry) => entry.isDirectory() && ID.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
