import { appendAudit } from "./audit.js";
import { contractTags } from "./contract.js";
import { ToolRefusal, actionHash, redeemToken, type PreparedAction, type Via } from "./approvals.js";
import { InputError } from "./inputs.js";
import { recordAction } from "./outbound.js";
import { PAUSED_REASON, isPaused } from "./pause.js";
import { loadPinnedContract } from "./pin.js";
import { NO_TAGS, deriveLevel, loadClientRules, needsApproval, type ClientRules, type FieldRef, type FloorCategory, type Level, type TagSource } from "./levels.js";

export type ToolArgs = Readonly<Record<string, unknown>>;
export type ToolResult = Readonly<Record<string, unknown>>;

/** Everything a tool call needs; the same for the MCP server and `installer tool` (§7.4). */
export interface ToolContext {
  readonly home: string;
  readonly now: () => string;
  readonly via: Via;
  readonly registry: ToolRegistry;
  readonly tags: TagSource;
  readonly rules: ClientRules;
  /** A sandbox run (D90, D91): every message and every other action above L0 is recorded in sandbox/outbox, never run. */
  readonly sandbox?: boolean;
  /** The workflow run making the call (`<workflow>/<run_id>`), kept with what a sandbox run records. */
  readonly run?: string;
}

/** One tool. Plans 5–6 add `records.*` and `channel.*` as more entries of this shape (D63). */
export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of each argument; tools/list shows them as one object that takes no other keys. */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
  /** Declared level (connector `risk.actions[tool].level` later); none means L2 (§11.4). */
  readonly level?: Level;
  readonly categories?: readonly FloorCategory[];
  /** Floor categories that depend on the call: its arguments and the live expected values (D71: an import that overwrites). */
  readonly floor?: (args: ToolArgs, expected: ToolArgs) => readonly FloorCategory[];
  /** Approval bookkeeping (approvals.*): fixed L0, never raised, never gated. */
  readonly meta?: boolean;
  /** Checks and normalises the arguments; unknown keys are refused, so the model can never pass a level. */
  readonly parse: (args: ToolArgs) => ToolArgs;
  readonly writes?: (args: ToolArgs) => readonly FieldRef[];
  /** Current values the action depends on; part of the action hash, re-read when the token is used (§9.6). */
  readonly expected?: (ctx: ToolContext, args: ToolArgs) => Promise<ToolArgs>;
  /** Why the call cannot run right now (quiet hours, D80), or null; checked before a token is spent, never at the request. */
  readonly ready?: (ctx: ToolContext, args: ToolArgs) => Promise<string | null>;
  /** Sends a message through `deliver`, which records it in a sandbox run instead of sending it (D91). */
  readonly outbound?: boolean;
  readonly run: (ctx: ToolContext, args: ToolArgs) => Promise<ToolResult>;
}

export type ToolRegistry = ReadonlyMap<string, ToolDef>;

/** The argument that carries an approval token; never part of the action hash. */
export const TOKEN_ARG = "approval_token";
const TOOL_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function createRegistry(defs: readonly ToolDef[]): ToolRegistry {
  return defs.reduce((registry, def) => {
    if (!TOOL_NAME.test(def.name)) throw new Error(`Tool name '${def.name}' must look like 'group.action'`);
    if (registry.has(def.name)) throw new Error(`Tool '${def.name}' is defined twice`);
    return new Map([...registry, [def.name, def]]);
  }, new Map<string, ToolDef>());
}

export function requireTool(registry: ToolRegistry, name: string): ToolDef {
  const tool = registry.get(name);
  if (!tool) throw new InputError(`Unknown tool '${name}'. Tools: ${[...registry.keys()].join(", ")}`);
  return tool;
}

export function argsOf(value: unknown): ToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError("Tool arguments must be a JSON object");
  return value as ToolArgs;
}

export function onlyKeys(args: ToolArgs, allowed: readonly string[], tool: string): void {
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new InputError(`${tool} does not take '${unknown}'${allowed.length > 0 ? `; it takes ${allowed.join(", ")}` : ""}`);
}

export const MAX_TEXT = 2000;

export function textArg(args: ToolArgs, key: string, tool: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new InputError(`${tool} needs '${key}' as non-empty text`);
  if (value.length > MAX_TEXT) throw new InputError(`${tool}: '${key}' is longer than ${MAX_TEXT} characters`);
  return value.trim();
}

export function idArg(args: ToolArgs, key: string, tool: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new InputError(`${tool} needs '${key}' as a whole number from 1`);
  return value;
}

/** Validated arguments, live expected values and the level the engine derives — never one the model chose (D59). */
export async function prepareAction(ctx: ToolContext, tool: ToolDef, args: ToolArgs): Promise<PreparedAction> {
  const parsed = tool.parse(args);
  const expected = tool.expected ? await tool.expected(ctx, parsed) : {};
  const categories = [...(tool.categories ?? []), ...(tool.floor?.(parsed, expected) ?? [])];
  const facts = { tool: tool.name, categories, writes: tool.writes?.(parsed) ?? [], ...(tool.level ? { level: tool.level } : {}) };
  const { level, reasons } = tool.meta ? { level: "L0" as const, reasons: ["approval bookkeeping (fixed L0)"] } : deriveLevel(facts, ctx.tags, ctx.rules);
  return { tool: tool.name, args: parsed, expected_values: expected, level, reasons, action_hash: actionHash(tool.name, parsed, expected) };
}

const toolAudit = (ctx: ToolContext, event: string, prepared: PreparedAction, extra: Record<string, unknown>) =>
  appendAudit(ctx.home, { ts: ctx.now(), actor: "agent", event, ref: prepared.tool, payload: { tool: prepared.tool, level: prepared.level, action_hash: prepared.action_hash, via: ctx.via, ...extra } });

/** Every refusal is audited, then thrown (§11.1). */
async function refuse(ctx: ToolContext, prepared: PreparedAction, reason: string): Promise<never> {
  await toolAudit(ctx, "tool.refused", prepared, { reason });
  throw new ToolRefusal(reason);
}

function approvalNeeded(prepared: PreparedAction): string {
  const request = JSON.stringify({ tool: prepared.tool, args: prepared.args, why: "<why this is needed>" });
  return `${prepared.tool} is ${prepared.level} (${prepared.reasons.join("; ")}): a person must approve it first. Call approvals.request with ${request}, `
    + `ask the person to approve it in their own terminal, then call approvals.get and call ${prepared.tool} again with the same arguments plus "${TOKEN_ARG}"`;
}

/** L0 runs silently; L1 and above are logged (§11.2); a failure after a spent token is logged too. */
async function runLogged(ctx: ToolContext, tool: ToolDef, prepared: PreparedAction, approval: number | null): Promise<ToolResult> {
  let result: ToolResult;
  try {
    result = await tool.run(ctx, prepared.args);
  } catch (error) {
    if (approval !== null) await toolAudit(ctx, "tool.failed", prepared, { approval, reason: (error as Error).message });
    throw error;
  }
  if (prepared.level !== "L0") await toolAudit(ctx, "tool.executed", prepared, { approval });
  return result;
}

/** A tool that cannot run right now is refused before its token is spent, so the approval stays usable (D80). */
async function refuseUnlessReady(ctx: ToolContext, tool: ToolDef, prepared: PreparedAction): Promise<void> {
  const reason = (await tool.ready?.(ctx, prepared.args)) ?? null;
  if (reason !== null) await refuse(ctx, prepared, reason);
}
/** D91: a sandbox run never acts: a message tool runs into the recording sink, any other action is recorded as it would run. */
async function sandboxCall(ctx: ToolContext, tool: ToolDef, prepared: PreparedAction): Promise<ToolResult> {
  if (tool.outbound) return tool.run(ctx, prepared.args);
  return recordAction(ctx.home, { tool: prepared.tool, args: prepared.args }, prepared.level, ctx.now(), ctx.run);
}

/** The gate (§11.1): L2 and L3 need a token for exactly this action; the same path for MCP and the CLI. */
export async function invokeTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = requireTool(ctx.registry, name);
  const { [TOKEN_ARG]: token, ...args } = argsOf(rawArgs);
  if (tool.meta && token !== undefined) throw new InputError(`${name} takes no ${TOKEN_ARG}`);
  const prepared = await prepareAction(ctx, tool, args);
  // The kill switch (D101): nothing above L0 acts while paused; a message tool still runs, into the recording sink.
  if (prepared.level !== "L0" && !tool.outbound && (await isPaused(ctx.home))) return refuse(ctx, prepared, PAUSED_REASON);
  if (ctx.sandbox && prepared.level !== "L0" && token === undefined) return sandboxCall(ctx, tool, prepared);
  if (!needsApproval(prepared.level)) {
    await refuseUnlessReady(ctx, tool, prepared);
    return runLogged(ctx, tool, prepared, null);
  }
  if (typeof token !== "string") return refuse(ctx, prepared, approvalNeeded(prepared));
  await refuseUnlessReady(ctx, tool, prepared);
  let approval: number;
  try {
    approval = (await redeemToken(ctx.home, token, prepared, ctx.now())).id;
  } catch (error) {
    if (error instanceof ToolRefusal) return refuse(ctx, prepared, error.message);
    throw error;
  }
  return runLogged(ctx, tool, prepared, approval);
}

export function objectSchema(fields: Readonly<Record<string, unknown>>, required: readonly string[]): Readonly<Record<string, unknown>> {
  return { type: "object", properties: fields, required, additionalProperties: false };
}

const TOKEN_FIELD = { type: "string", description: "Token from approvals.get once a person approved this exact call" };

/** What tools/list shows: gated tools take an optional approval_token; meta tools do not. */
export function describeTools(registry: ToolRegistry): readonly { name: string; description: string; inputSchema: Readonly<Record<string, unknown>> }[] {
  return [...registry.values()].map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: objectSchema(tool.meta ? tool.fields : { ...tool.fields, [TOKEN_ARG]: TOKEN_FIELD }, tool.required),
  }));
}

/** Field tags come from the data contract the install pinned (§9.3); a home without one has no tagged fields. */
export async function toolContext(home: string, via: Via, registry: ToolRegistry, now: () => string = () => new Date().toISOString()): Promise<ToolContext> {
  const contract = await loadPinnedContract(home);
  return { home, now, via, registry, tags: contract ? contractTags(contract) : NO_TAGS, rules: await loadClientRules(home) };
}
