import { readFile } from "node:fs/promises";
import { KNOWN_ACTIONS, KNOWN_CHECKS } from "./actions.js";
import { INPUT_KINDS, PHASES, STEP_TYPES, type Phase, type Solution, type StepDef, type StepInput, type StepType } from "./types.js";

export class SolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolutionError";
  }
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new SolutionError(`${where} must be a non-empty string`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (!(allowed as readonly unknown[]).includes(value)) throw new SolutionError(`${where} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function parseInput(value: unknown, where: string): StepInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SolutionError(`${where} must be an object`);
  const kind = oneOf(value.kind, INPUT_KINDS, `${where}.kind`);
  const options = value.options;
  if ((kind === "choice" || kind === "multi_choice") && (!Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === "string"))) {
    throw new SolutionError(`${where}.options must list the choices`);
  }
  return { kind, ...(Array.isArray(options) ? { options: options as string[] } : {}), ...(typeof value.provider === "string" ? { provider: value.provider } : {}) };
}

function named(value: unknown, key: "action" | "check", known: readonly string[], where: string): { name: string; args: Raw } {
  if (!isRecord(value)) throw new SolutionError(`${where} must be an object`);
  const name = oneOf(value[key], known, `${where}.${key}`);
  return { name, args: isRecord(value.args) ? value.args : {} };
}

function checkTypeRules(step: StepDef, where: string): void {
  if (step.type === "ask" && !step.input) throw new SolutionError(`${where}: ask steps need an input`);
  if (step.type === "auto" && !step.auto) throw new SolutionError(`${where}: auto steps need an auto action`);
  if (step.type === "verify" && !step.verify) throw new SolutionError(`${where}: verify steps need a check`);
  if (step.type === "agent_action" && (!step.intent || !step.verify)) throw new SolutionError(`${where}: agent_action steps need an intent and a check`);
}

function optionalFields(value: Raw, where: string): Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify">> {
  const result: Record<string, unknown> = {};
  if (Array.isArray(value.instructions)) {
    result.instructions = value.instructions.map((line) => text(line, `${where}.instructions`));
  }
  if (value.input !== undefined) {
    const parsed = parseInput(value.input, `${where}.input`);
    if (parsed) result.input = parsed;
  }
  if (typeof value.est_minutes === "number") {
    result.est_minutes = value.est_minutes;
  }
  if (typeof value.intent === "string" && value.intent.trim() !== "") {
    result.intent = value.intent;
  }
  const auto = value.auto === undefined ? undefined : named(value.auto, "action", KNOWN_ACTIONS, `${where}.auto`);
  if (auto) {
    result.auto = { action: auto.name, args: auto.args };
  }
  const verify = value.verify === undefined ? undefined : named(value.verify, "check", KNOWN_CHECKS, `${where}.verify`);
  if (verify) {
    result.verify = { check: verify.name, args: verify.args };
  }
  return result as Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify">>;
}

function parseStep(value: unknown, index: number): StepDef {
  const where = `steps[${index}]`;
  if (!isRecord(value)) throw new SolutionError(`${where} must be an object`);
  if (typeof value.blocking !== "boolean") throw new SolutionError(`${where}.blocking must be true or false`);
  const step: StepDef = {
    step_id: text(value.step_id, `${where}.step_id`),
    phase: oneOf<Phase>(value.phase, PHASES, `${where}.phase`),
    type: oneOf<StepType>(value.type, STEP_TYPES, `${where}.type`),
    title: text(value.title, `${where}.title`),
    why: text(value.why, `${where}.why`),
    blocking: value.blocking,
    ...optionalFields(value, where),
  };
  checkTypeRules(step, where);
  return step;
}

export function parseSolution(raw: unknown): Solution {
  if (!isRecord(raw)) throw new SolutionError("Solution must be a JSON object");
  const id = text(raw.id, "id");
  const version = text(raw.version, "version");
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new SolutionError("steps must be a non-empty list");
  const steps = raw.steps.map(parseStep);
  steps.reduce((seen, step) => {
    if (seen.has(step.step_id)) throw new SolutionError(`Duplicate step id '${step.step_id}'`);
    return new Set([...seen, step.step_id]);
  }, new Set<string>());
  steps.reduce((previous, step) => {
    const index = PHASES.indexOf(step.phase);
    if (index < previous) throw new SolutionError(`Step '${step.step_id}' is in phase ${step.phase}, earlier than the previous step`);
    return index;
  }, 0);
  return { id, version, steps };
}

export function parseSolutionText(text: string, where: string): Solution {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SolutionError(`Solution file '${where}' is not valid JSON`);
  }
  return parseSolution(json);
}

export async function loadSolutionSource(ref: string): Promise<{ solution: Solution; text: string }> {
  if (!ref.startsWith("file:")) throw new SolutionError(`Unsupported solution reference '${ref}': only file:<path> is supported in this version`);
  const path = ref.slice("file:".length);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new SolutionError(`Cannot read solution file '${path}'`);
  }
  return { solution: parseSolutionText(text, path), text };
}

export async function loadSolution(ref: string): Promise<Solution> {
  return (await loadSolutionSource(ref)).solution;
}
