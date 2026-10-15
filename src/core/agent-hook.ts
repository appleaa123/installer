import { appendFile, open, readFile } from "node:fs/promises";
import { canonicalJson } from "./audit.js";

/**
 * The hook a task step's agent runs around each tool call (D137): Claude Code's PreToolUse, PostToolUse and
 * PostToolUseFailure call `taskfollow agent-hook pre|post|failed <config>` with the event on stdin. Before a call it
 * is the gate: only what the step lists in `may_use` goes ahead; a listed command-line tool cannot be joined to
 * another command; a write flag is refused in a step that may not change anything. After a call it adds one line to
 * the step's record: time, session, tool, a short masked summary of the input, outcome and duration, never the
 * tool's output. The agent's stated reason is the `actions.reason` call itself, recorded the same way. Inside a run
 * the hook fails closed: when it cannot read its input, or cannot record a refusal, the call is blocked (exit 2).
 */
/** Claude Code shows TaskFollow's `actions.reason` tool under this name (dots become underscores, D56). */
export const REASON_TOOL = "mcp__installer__actions_reason";
/** Claude Code's own tool that returns the answer when a run has `--json-schema`; it acts on nothing. */
export const ANSWER_TOOL = "StructuredOutput";
/** Claude Code reads exit 2 from a hook as "block this call". */
export const HOOK_BLOCK = 2;
const SUMMARY_MAX = 200;
/** Joins a second command onto a listed one: separators, pipes, substitution, redirection, a new line. */
const SHELL_JOIN = /[;&|`<>\n\r]|\$\(/;
/** Flags and variables that turn a read into a write for command-line tools we know of. */
const WRITE_FLAGS = ["--allow-mutations", "SHOPIFY_FLAG_ALLOW_MUTATIONS"];

export interface HookConfig {
  /** The step's record file (JSON Lines). */
  readonly record: string;
  /** Claude Code permission rules: `mcp__server`, `mcp__server__tool`, `mcp__server__prefix*`, `Bash(prefix:*)`, `Bash(exact)`. */
  readonly may_use: readonly string[];
  /** Whether the step may change things (write flags allowed). */
  readonly changes: boolean;
  /** D151: a person approved this one call; nothing else may run, and it may run once. */
  readonly exact?: { readonly tool: string; readonly args: Readonly<Record<string, unknown>> };
}

export type Phase = "pre" | "post" | "failed";
export type Decision = { readonly allow: true } | { readonly allow: false; readonly reason: string };
export interface HookOutput {
  readonly exit: number;
  readonly stdout: string;
  readonly stderr?: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadHookConfig(file: string): Promise<HookConfig> {
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!isRecord(raw) || typeof raw.record !== "string" || !Array.isArray(raw.may_use) || !raw.may_use.every((rule) => typeof rule === "string") || typeof raw.changes !== "boolean") {
    throw new Error("The hook settings are damaged");
  }
  const exact = raw.exact;
  if (exact !== undefined && !(isRecord(exact) && typeof exact.tool === "string" && isRecord(exact.args))) throw new Error("The hook settings are damaged");
  return { record: raw.record, may_use: raw.may_use as string[], changes: raw.changes, ...(exact === undefined ? {} : { exact: { tool: exact.tool as string, args: exact.args as Raw } }) };
}

/** The file whose creation marks the approved call as made: next to the step's record, created at most once. */
export const madeMarker = (record: string): string => (record.endsWith(".calls.jsonl") ? record.slice(0, -".calls.jsonl".length) : record) + ".made";
const APPROVED_SHOWN = 4000;

/** D151: only the approved call, with exactly the approved arguments, and only the first time. */
async function decideExact(event: Raw, exact: NonNullable<HookConfig["exact"]>, record: string): Promise<Decision> {
  const tool = typeof event.tool_name === "string" ? event.tool_name : "";
  if (tool === REASON_TOOL) return { allow: true };
  const approved = canonicalJson(exact.args);
  if (tool !== exact.tool || !isRecord(event.tool_input) || canonicalJson(event.tool_input) !== approved) {
    return { allow: false, reason: `Only the approved call may run: ${exact.tool} with exactly these arguments: ${approved.slice(0, APPROVED_SHOWN)}` };
  }
  try {
    await (await open(madeMarker(record), "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { allow: false, reason: "The approved call was already made; it runs only once." };
    throw error;
  }
  return { allow: true };
}

const commandOf = (input: unknown): string => (isRecord(input) && typeof input.command === "string" ? input.command : "");

export function matchesRule(rule: string, tool: string, input: unknown): boolean {
  const bash = /^Bash\((.+)\)$/.exec(rule);
  if (bash) {
    if (tool !== "Bash") return false;
    const pattern = bash[1] ?? "";
    const command = commandOf(input).trim();
    return pattern.endsWith(":*") ? command === pattern.slice(0, -2) || command.startsWith(`${pattern.slice(0, -2)} `) : command === pattern;
  }
  if (rule.endsWith("*")) return tool.startsWith(rule.slice(0, -1));
  return tool === rule || (rule.startsWith("mcp__") && rule.split("__").length === 2 && tool.startsWith(`${rule}__`));
}

export function decide(event: Raw, config: HookConfig): Decision {
  const tool = typeof event.tool_name === "string" ? event.tool_name : "";
  if (tool === REASON_TOOL || tool === ANSWER_TOOL) return { allow: true };
  if (!config.may_use.some((rule) => matchesRule(rule, tool, event.tool_input))) {
    return { allow: false, reason: `This step may only use: ${config.may_use.join(", ")}. Return what you found instead, or explain what a person should do.` };
  }
  if (tool !== "Bash") return { allow: true };
  const command = commandOf(event.tool_input);
  if (SHELL_JOIN.test(command)) return { allow: false, reason: "Run one command at a time, without ; & | > < ` or $( )." };
  if (!config.changes && WRITE_FLAGS.some((flag) => command.includes(flag))) return { allow: false, reason: "This step may only read; it cannot change anything." };
  return { allow: true };
}

/** A constant such as `CREATED_AT` after a name like `sortKey` is not a secret (task 25). */
const CONSTANT = /^[A-Z]+(_[A-Z]+)+$/;

/** At most 200 characters of the input, with values that look like keys or tokens masked. */
export function summarize(input: unknown): string {
  const text = (typeof input === "string" ? input : JSON.stringify(input) ?? "")
    .replace(/(bearer|token|key|secret|password|authorization)(["':=\s]+)([^\s"',}]{8,})/gi, (whole, name: string, gap: string, value: string) => (CONSTANT.test(value) ? whole : `${name}${gap}[masked]`))
    .replace(/\b(shpat|shpca|shppa|xox[abp]|xapp|sk|ghp|glpat)[-_][A-Za-z0-9_-]{8,}/g, "[masked]");
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

function recordLine(phase: Phase, event: Raw, now: string, refused?: string): Raw {
  const tool = typeof event.tool_name === "string" ? event.tool_name : "";
  const input = event.tool_input;
  const base = { ts: now, session: typeof event.session_id === "string" ? event.session_id : "", tool };
  if (tool === REASON_TOOL && isRecord(input)) {
    return { ...base, reason_for: typeof input.tool === "string" ? input.tool : "", why: typeof input.why === "string" ? input.why.slice(0, 500) : "" };
  }
  const errored = isRecord(event.tool_response) && event.tool_response.isError === true;
  const outcome = refused !== undefined ? "refused" : phase === "failed" || errored ? "failed" : "ok";
  return { ...base, input: summarize(input), outcome, ...(typeof event.duration_ms === "number" ? { ms: event.duration_ms } : {}), ...(refused ? { refused_because: refused } : {}) };
}

const denyOutput = (reason: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

export async function handleHook(phase: Phase, stdin: string, config: HookConfig, now: () => string = () => new Date().toISOString()): Promise<HookOutput> {
  let event: Raw;
  try {
    const parsed: unknown = JSON.parse(stdin);
    if (!isRecord(parsed)) throw new Error("not an object");
    event = parsed;
  } catch {
    return { exit: HOOK_BLOCK, stdout: "", stderr: "TaskFollow could not read this tool call, so it was blocked." };
  }
  if (event.tool_name === ANSWER_TOOL) return { exit: 0, stdout: "" };
  let decision: Decision;
  try {
    decision = phase !== "pre" ? { allow: true } : config.exact ? await decideExact(event, config.exact, config.record) : decide(event, config);
  } catch {
    return { exit: HOOK_BLOCK, stdout: "", stderr: "TaskFollow could not check this tool call, so it was blocked." };
  }
  if (phase === "pre" && decision.allow) return { exit: 0, stdout: "" };
  try {
    await appendFile(config.record, `${JSON.stringify(recordLine(phase, event, now(), decision.allow ? undefined : decision.reason))}\n`, { mode: 0o600 });
  } catch {
    return { exit: HOOK_BLOCK, stdout: "", stderr: "TaskFollow could not record this tool call, so it was blocked." };
  }
  return decision.allow ? { exit: 0, stdout: "" } : { exit: 0, stdout: denyOutput(decision.reason) };
}
