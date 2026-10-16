import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { KNOWN_ACTIONS, KNOWN_CHECKS } from "./actions.js";
import { parseChannelPolicy } from "./channel-policy.js";
import { CONNECTOR_PINS, CONNECTOR_SECRETS } from "./connectors.js";
import { ContractError, parseContract, type DataContract } from "./contract.js";
import { MODE_ARGS, MODE_QUESTION_RULE, acceptsModeLiteral, acceptsModeQuestion } from "./mode.js";
import { validateInput } from "./inputs.js";
import { INPUT_KINDS, PHASES, STEP_TYPES, type Phase, type Solution, type StepDef, type StepInput, type StepType, type StepWhen, type StepWhenAnswer, type StepWhenAny } from "./types.js";

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

/** A default is the answer the helper submits when the person is not sure, so it must be a valid answer. */
function checkDefault(step: StepDef, where: string): void {
  if (step.default === undefined) return;
  if (step.type !== "ask") throw new SolutionError(`${where}.default only belongs on an ask step`);
  try {
    validateInput(step.input, step.default);
  } catch (error) {
    throw new SolutionError(`${where}.default is not a valid answer: ${(error as Error).message}`);
  }
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

/** A step's guide names a connector of the catalog; whether it has a setup block is `taskfollow guide`'s check. */
function parseGuide(value: unknown, where: string): string {
  if (typeof value !== "string" || !Object.hasOwn(CONNECTOR_PINS, value)) {
    throw new SolutionError(`${where} must name a connector in this installer's catalog (${Object.keys(CONNECTOR_PINS).join(", ")}), got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalFields(value: Raw, where: string): Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify" | "hints" | "guide">> {
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
  if (value.guide !== undefined) {
    result.guide = parseGuide(value.guide, `${where}.guide`);
  }
  return result as Partial<Pick<StepDef, "instructions" | "input" | "est_minutes" | "intent" | "auto" | "verify" | "hints" | "guide">>;
}

/** One answer a condition looks at (D131); the question itself is checked in checkWhenReferences. */
function parseWhenAnswer(value: unknown, where: string): StepWhenAnswer {
  if (!isRecord(value)) throw new SolutionError(`${where} must be an object`);
  if (value.any !== undefined) throw new SolutionError(`${where}: an any cannot hold another any`);
  if (value.all !== undefined) throw new SolutionError(`${where}: an any cannot hold an all`);
  const step = text(value.step, `${where}.step`);
  const hasEquals = value.equals !== undefined;
  const hasIncludes = value.includes !== undefined;
  if (hasEquals === hasIncludes) throw new SolutionError(`${where} needs exactly one of equals or includes`);
  return { step, ...(hasEquals ? { equals: text(value.equals, `${where}.equals`) } : { includes: text(value.includes, `${where}.includes`) }) };
}

/** `when`: shown only when an earlier question was answered this way (D131), or when any of 2 to 8 such answers holds (9.12 item 3). */
function parseAny(value: Record<string, unknown>, where: string): StepWhenAny {
  if (!Array.isArray(value.any) || value.any.length < MIN_ANY || value.any.length > MAX_ANY) throw new SolutionError(`${where}.any must list 2 to 8 conditions`);
  return { any: value.any.map((part, index) => parseWhenAnswer(part, `${where}.any[${index}]`)) };
}

/** An `all` part: one answer, or an any of answers; never another all (PR #45 review). */
function parseAllPart(value: unknown, where: string): StepWhenAnswer | StepWhenAny {
  if (isRecord(value) && value.all !== undefined) throw new SolutionError(`${where}: an all cannot hold another all`);
  return isRecord(value) && value.any !== undefined ? parseAny(value, where) : parseWhenAnswer(value, where);
}

function parseWhen(value: unknown, where: string): StepWhen {
  if (isRecord(value) && value.all !== undefined) {
    if (!Array.isArray(value.all) || value.all.length < MIN_ANY || value.all.length > MAX_ANY) throw new SolutionError(`${where}.all must list 2 to 8 conditions`);
    return { all: value.all.map((part, index) => parseAllPart(part, `${where}.all[${index}]`)) };
  }
  if (!isRecord(value) || value.any === undefined) return parseWhenAnswer(value, where);
  return parseAny(value, where);
}

const MIN_ANY = 2;
const MAX_ANY = 8;

/** A condition may only look back at an earlier choice that has options, and only for one of those options, so a step can never be hidden for ever by a typo. */
function checkWhen(when: StepWhen, earlier: readonly StepDef[], label: string): void {
  if ("any" in when || "all" in when) {
    for (const part of "any" in when ? when.any : when.all) checkWhen(part, earlier, label);
    return;
  }
  const asked = earlier.find((candidate) => candidate.type === "ask" && candidate.step_id === when.step);
  if (!asked) throw new SolutionError(`${label}: when.step must name an earlier ask step, got ${JSON.stringify(when.step)}`);
  const wanted = when.equals ?? when.includes ?? "";
  const kind = when.equals !== undefined ? "choice" : "multi_choice";
  if (asked.input?.kind !== kind) {
    throw new SolutionError(`${label}: when.${when.equals !== undefined ? "equals" : "includes"} needs a ${kind === "choice" ? "single choice" : "multiple choice"} question, but '${asked.step_id}' is not one`);
  }
  if (!(asked.input.options ?? []).includes(wanted)) {
    throw new SolutionError(`${label}: when asks for ${JSON.stringify(wanted)}, which is not one of its options (${(asked.input.options ?? []).join(", ")})`);
  }
}

function checkWhenReferences(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    if (step.when) checkWhen(step.when, steps.slice(0, index), `Step '${step.step_id}'`);
  });
}

/** A suggested workflow may depend on a choice too; every step comes before it. */
function checkSuggestionWhen(steps: readonly StepDef[], workflows: readonly Readonly<Record<string, unknown>>[] | undefined): void {
  for (const entry of workflows ?? []) {
    if (entry.when !== undefined) checkWhen(parseWhen(entry.when, `workflow '${String(entry.workflow)}' when`), steps, `Workflow '${String(entry.workflow)}'`);
  }
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
    ...(value.when === undefined ? {} : { when: parseWhen(value.when, `${where}.when`) }),
    ...(value.default === undefined ? {} : { default: value.default }),
  };
  checkTypeRules(step, where);
  checkDefault(step, where);
  return step;
}

/** derive_mode reads earlier answers; refuse a solution whose references point nowhere (Review Focus 4). */
function checkModeReferences(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    if (step.auto?.action !== "derive_mode") return;
    const earlierAsks = new Map(steps.slice(0, index).filter((earlier) => earlier.type === "ask").map((earlier) => [earlier.step_id, earlier]));
    for (const key of MODE_ARGS) {
      const ref = step.auto.args?.[key];
      if (isRecord(ref) && "value" in ref && acceptsModeLiteral(key, ref.value)) continue;
      const asked = typeof ref === "string" ? earlierAsks.get(ref) : undefined;
      if (!asked || !acceptsModeQuestion(key, asked.input)) {
        const rule = MODE_QUESTION_RULE[key];
        throw new SolutionError(`Step '${step.step_id}': derive_mode args.${key} must name an earlier ask step with ${rule}, got ${JSON.stringify(ref ?? null)}`);
      }
    }
  });
}

/** probe_runtime may only name a runtime profile id, never a file (D34: solution text never grants capabilities). */
function checkProbeArgs(steps: readonly StepDef[]): void {
  for (const step of steps) {
    const profile = step.auto?.action === "probe_runtime" ? step.auto.args?.profile : undefined;
    if (profile !== undefined && (typeof profile !== "string" || !PROFILE_ID.test(profile))) {
      throw new SolutionError(`Step '${step.step_id}': probe_runtime args.profile must be a runtime profile id such as 'claude-code', not a path`);
    }
  }
}

/** BRAIN steps read what earlier engine steps recorded (the probed profile, the registration). */
const NEEDS_EARLIER: Readonly<Record<string, string>> = { register_mcp: "probe_runtime", probe_mcp: "register_mcp", register_tools_mcp: "probe_runtime" };

function checkBrainOrder(steps: readonly StepDef[]): void {
  steps.forEach((step, index) => {
    const action = step.auto?.action ?? "";
    if (!Object.hasOwn(NEEDS_EARLIER, action)) return;
    const needed = NEEDS_EARLIER[action];
    if (!steps.slice(0, index).some((earlier) => earlier.auto?.action === needed)) throw new SolutionError(`Step '${step.step_id}': ${action} needs an earlier ${needed} step`);
  });
}
const SECRET_ID = /^[a-z0-9-]+$/;

/** A secret or oauth step names its id in input.provider and is confirmed by secret_present for that id, so `taskfollow secret <provider>` always fits (§8.3). */
function checkSecretSteps(steps: readonly StepDef[]): void {
  for (const step of steps) {
    const kind = step.input?.kind;
    if (step.type !== "human_action" || (kind !== "secret" && kind !== "oauth")) continue;
    const provider = step.input?.provider;
    if (!provider || !SECRET_ID.test(provider)) throw new SolutionError(`Step '${step.step_id}': a ${kind} step needs input.provider, the secret id entered with 'taskfollow secret <provider>'`);
    if (step.verify?.check !== "secret_present" || step.verify.args?.id !== provider) {
      throw new SolutionError(`Step '${step.step_id}': a ${kind} step must verify with { "check": "secret_present", "args": { "id": "${provider}" } }`);
    }
  }
}
/** oauth_ready names the keychain item of a catalog connector's sign-in (live setup guides, 4.5), so it cannot fail on every run. */
function checkOauthReadySteps(steps: readonly StepDef[]): void {
  const secrets = Object.values(CONNECTOR_SECRETS);
  for (const step of steps) {
    if (step.verify?.check !== "oauth_ready") continue;
    const id = step.verify.args?.id;
    if (typeof id !== "string" || !secrets.includes(id)) {
      throw new SolutionError(`Step '${step.step_id}': oauth_ready needs args.id, the sign-in secret of a connector (${secrets.join(", ")})`);
    }
  }
}
/** source_present and mapping_present name an entity of the solution's own data contract (§9.4). */
function checkDataSteps(steps: readonly StepDef[], contract: DataContract | undefined): void {
  for (const step of steps) {
    const check = step.verify?.check;
    if (check !== "source_present" && check !== "mapping_present") continue;
    const entity = step.verify?.args?.entity;
    if (typeof entity !== "string" || !contract || !Object.hasOwn(contract.entities, entity)) {
      throw new SolutionError(`Step '${step.step_id}': ${check} needs args.entity, an entity of the solution's data_contract`);
    }
  }
}
/** Recipe suggestions (§6.2 WORKFLOWS): ids are checked here, the rest when `taskfollow workflow add` writes one. */
function parseSuggestions(value: unknown): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isRecord)) throw new SolutionError("workflows must be a list of workflow objects");
  const ids = value.map((entry) => entry.workflow);
  if (!ids.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new SolutionError("each suggested workflow needs its own id in 'workflow': lowercase letters, digits and dashes");
  }
  return value;
}

function parseDataContract(value: unknown): DataContract | undefined {
  if (value === undefined) return undefined;
  try {
    return parseContract(value);
  } catch (error) {
    if (error instanceof ContractError) throw new SolutionError(error.message);
    throw error;
  }
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
  checkWhenReferences(steps);
  checkProbeArgs(steps);
  checkSecretSteps(steps);
  checkOauthReadySteps(steps);
  checkBrainOrder(steps);
  const contract = parseDataContract(raw.data_contract);
  checkDataSteps(steps, contract);
  const policy = parseChannelPolicy(raw.channel_policy);
  const workflows = parseSuggestions(raw.workflows);
  checkSuggestionWhen(steps, workflows);
  return { id, version, steps, ...(contract ? { data_contract: contract } : {}), ...(policy ? { channel_policy: policy } : {}), ...(workflows ? { workflows } : {}) };
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

/** Solutions that ship inside the package, loadable by name: `taskfollow start --solution starter` (D129). */
export const BUNDLED_SOLUTIONS = ["starter", "starter-skillswiki"] as const;

/** `fetchSkillswiki` is the key-bearing fetcher the CLI builds once the key and URL are known (D46). */
export async function loadSolutionSource(ref: string, fetchText: FetchText = fetchHttps, fetchSkillswiki?: FetchText): Promise<{ solution: Solution; text: string }> {
  if (ref.startsWith("skillswiki:")) {
    if (!fetchSkillswiki) throw new SolutionError("'skillswiki:' references need the Skills Wiki key and URL: run 'taskfollow secret skillswiki', then start with --url <MCP URL>");
    const text = await fetchSkillswiki(ref);
    return { solution: parseSolutionText(text, ref), text };
  }
  if (ref.startsWith("https:")) {
    const text = await fetchText(ref);
    return { solution: parseSolutionText(text, ref), text };
  }
  if ((BUNDLED_SOLUTIONS as readonly string[]).includes(ref)) {
    const text = await readLocal(fileURLToPath(new URL(`../../solutions/${ref}.json`, import.meta.url)));
    return { solution: parseSolutionText(text, ref), text };
  }
  if (!ref.startsWith("file:")) throw new SolutionError(`Unsupported solution reference '${ref}': use ${BUNDLED_SOLUTIONS.join(", ")}, file:<path> or https://…`);
  const path = ref.slice("file:".length);
  const text = await readLocal(path);
  return { solution: parseSolutionText(text, path), text };
}

export async function loadSolution(ref: string): Promise<Solution> {
  return (await loadSolutionSource(ref)).solution;
}
