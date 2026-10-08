import { readFile } from "node:fs/promises";
import { KNOWN_ACTIONS, KNOWN_CHECKS } from "./actions.js";
import { MODE_ARGS } from "./mode.js";
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

const PROFILE_ID = /^[a-z0-9-]+$/;

/** Per-runtime lines for an agent_action, keyed by runtime profile id (D7 hint files). */
function parseHints(value: unknown, where: string): Readonly<Record<string, readonly string[]>> {
  if (!isRecord(value)) throw new SolutionError(`${where} must map runtime profile ids to lists of lines`);
  return Object.fromEntries(
    Object.entries(value).map(([id, lines]) => {
      if (!PROFILE_ID.test(id) || !Array.isArray(lines) || lines.length === 0) throw new SolutionError(`${where}.${id} must be a non-empty list of lines`);
      return [id, lines.map((line) => text(line, `${where}.${id}`))];
    }),
  );
}

function optionalFields(value: Raw, where: string): Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify" | "hints">> {
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
  if (value.hints !== undefined) {
    result.hints = parseHints(value.hints, `${where}.hints`);
  }
  return result as Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify" | "hints">>;
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

/** derive_mode reads earlier answers; refuse a solution whose references point nowhere (Review Focus 4). */
function checkModeReferences(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    if (step.auto?.action !== "derive_mode") return;
    const earlierAsks = new Set(steps.slice(0, index).filter((earlier) => earlier.type === "ask").map((earlier) => earlier.step_id));
    for (const key of MODE_ARGS) {
      const ref = step.auto.args?.[key];
      if (typeof ref !== "string" || !earlierAsks.has(ref)) {
        throw new SolutionError(`Step '${step.step_id}': derive_mode args.${key} must name an earlier ask step, got ${JSON.stringify(ref ?? null)}`);
      }
    }
  });
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
  checkModeReferences(steps);
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

export const MAX_SOLUTION_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 30_000;

export type FetchText = (url: string) => Promise<string>;

/** HTTPS only, follows redirects but never to another scheme, size-capped (Review Focus 3). */
export async function fetchHttps(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new SolutionError(`Cannot fetch solution URL '${url}' (${(error as Error).message})`);
  }
  if (!response.url.startsWith("https:")) throw new SolutionError(`Solution URL '${url}' redirected away from https`);
  if (!response.ok) throw new SolutionError(`Solution URL '${url}' answered HTTP ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_SOLUTION_BYTES) {
    throw new SolutionError(`Solution at '${url}' is larger than ${MAX_SOLUTION_BYTES} bytes`);
  }
  return text;
}

async function readLocal(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new SolutionError(`Cannot read solution file '${path}'`);
  }
}

export async function loadSolutionSource(ref: string, fetchText: FetchText = fetchHttps): Promise<{ solution: Solution; text: string }> {
  if (ref.startsWith("skillswiki:")) {
    throw new SolutionError("'skillswiki:' references need the Skills Wiki key step, which arrives in a later version; use a file: or https: reference");
  }
  if (ref.startsWith("https:")) {
    const text = await fetchText(ref);
    return { solution: parseSolutionText(text, ref), text };
  }
  if (!ref.startsWith("file:")) throw new SolutionError(`Unsupported solution reference '${ref}': use file:<path> or https://…`);
  const path = ref.slice("file:".length);
  const text = await readLocal(path);
  return { solution: parseSolutionText(text, path), text };
}

export async function loadSolution(ref: string): Promise<Solution> {
  return (await loadSolutionSource(ref)).solution;
}
