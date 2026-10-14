import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { appendAudit, canonicalJson } from "./audit.js";
import { InputError } from "./inputs.js";
import { LEVELS, ROLES, needsApproval, requiredRole, roleAtLeast, type Level, type Role } from "./levels.js";
import { claimOnce, createRecord, isClaimed, listRecords, readRecord, replaceRecord } from "./numbered.js";
import type { Roles } from "./types.js";

/** Approval items, one file each (D57); `<id>.claimed` marks a token as spent (D58). */
export const APPROVALS_DIR = join("state", "approvals");
/** An item, and the token issued for it, can be used for 24 hours after the request (D62). */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "expired", "used"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
const TOKEN_PATTERN = /^([1-9]\d*)\.[0-9a-f]{64}$/;
/** Which surface made a tool call: the agent over MCP, the shell (`taskpilot tool`), the gateway itself (D79), or a workflow run (D81). */
export type Via = "mcp" | "cli" | "gateway" | "runner";

export interface ProposedAction {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** A tool call made ready for the gate: checked arguments, live expected values, derived level, hash (D58, D59). */
export interface PreparedAction extends ProposedAction {
  readonly expected_values: Readonly<Record<string, unknown>>;
  readonly level: Level;
  readonly reasons: readonly string[];
  readonly action_hash: string;
}

export interface Decision {
  readonly decision: "approved" | "edited" | "rejected";
  readonly by: string;
  readonly role: Role;
  readonly at: string;
  readonly reason?: string;
  /** The action as requested, kept when a person edited it (a learning candidate later, §11.5). */
  readonly original?: ProposedAction;
}

/** The workflow run and step that asked for an approval (D87). */
export interface RunRef {
  readonly workflow: string;
  readonly run_id: string;
  readonly step: string;
  /** Asked because a typed tool step's derived level needs it (not an approve step, not an agent's call): earned autonomy may apply (D94). */
  readonly policy?: boolean;
}

/** Spec §11.5. `source.via` says which surface asked; a workflow's request also names its run and step. */
export interface ApprovalItem {
  readonly id: number;
  readonly source: { readonly via: Via; readonly run?: RunRef };
  readonly level: Level;
  readonly urgent: boolean;
  readonly action: ProposedAction;
  readonly expected_values: Readonly<Record<string, unknown>>;
  readonly action_hash: string;
  readonly preview: string;
  readonly why: string;
  readonly evidence: readonly string[];
  readonly required_role: Role;
  readonly created_at: string;
  readonly expires_at: string;
  readonly status: ApprovalStatus;
  readonly decision?: Decision;
  readonly token?: string;
  readonly used_at?: string;
}

export interface ApprovalRequest {
  readonly prepared: PreparedAction;
  readonly why: string;
  readonly preview?: string;
  readonly evidence?: readonly string[];
  readonly urgent?: boolean;
  readonly via: Via;
  readonly run?: RunRef;
}

/** Who decides at the terminal, and with which role (D60). */
export interface Decider {
  readonly name: string;
  readonly role: Role;
}

/** The gate refused a tool call; nothing ran (§11.1). */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolRefusal";
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** An item as the agent and the approvals list show it: everything except the token. */
export function withoutToken(item: ApprovalItem): Omit<ApprovalItem, "token"> {
  const { token: _token, ...rest } = item;
  return rest;
}

/** §11.1: `sha256(canonical_json({tool, args, expected_values}))`; a tool without expected values hashes `{}`. */
export function actionHash(tool: string, args: Readonly<Record<string, unknown>>, expectedValues: Readonly<Record<string, unknown>>): string {
  return `sha256:${sha256(canonicalJson({ tool, args, expected_values: expectedValues }))}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isApprovalItem(value: unknown): value is ApprovalItem {
  if (!isRecord(value) || typeof value.id !== "number" || !isRecord(value.action) || typeof value.action.tool !== "string") return false;
  if (!(LEVELS as readonly unknown[]).includes(value.level) || !(ROLES as readonly unknown[]).includes(value.required_role)) return false;
  if (!(APPROVAL_STATUSES as readonly unknown[]).includes(value.status)) return false;
  return ["action_hash", "why", "preview", "created_at", "expires_at"].every((key) => typeof value[key] === "string");
}

const audit = (home: string, now: string, actor: "human" | "agent" | "engine", event: string, item: ApprovalItem, extra: Record<string, unknown> = {}) =>
  appendAudit(home, { ts: now, actor, event, ref: `approval:${item.id}`, payload: { id: item.id, tool: item.action.tool, level: item.level, action_hash: item.action_hash, ...extra } });

/** The preview an item gets when the agent gives none. */
export function previewOf(action: ProposedAction): string {
  const text = `${action.tool} ${canonicalJson(action.args)}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** `why` is mandatory (§11.5); only L2 and L3 actions need an item. */
export async function requestApproval(home: string, request: ApprovalRequest, now: string): Promise<ApprovalItem> {
  const { prepared } = request;
  const why = request.why.trim();
  if (why === "") throw new InputError("An approval request needs a why: say in one sentence why this action is needed");
  if (!needsApproval(prepared.level)) throw new InputError(`${prepared.tool} is ${prepared.level} and needs no approval: call it directly`);
  const action = { tool: prepared.tool, args: prepared.args };
  const item = await createRecord<ApprovalItem>(home, APPROVALS_DIR, (id) => ({
    id, source: { via: request.via, ...(request.run ? { run: request.run } : {}) }, level: prepared.level, urgent: request.urgent ?? false, action,
    expected_values: prepared.expected_values, action_hash: prepared.action_hash,
    preview: request.preview?.trim() || previewOf(action), why, evidence: request.evidence ?? [],
    required_role: requiredRole(prepared.level) ?? "member", created_at: now,
    expires_at: new Date(Date.parse(now) + APPROVAL_TTL_MS).toISOString(), status: "pending",
  }));
  await audit(home, now, "agent", "approval.requested", item, { reasons: prepared.reasons });
  return item;
}

/** A token claimed by a call that crashed before recording it is spent (D58): say so instead of "approved". */
async function settleSpent(home: string, item: ApprovalItem, now: string): Promise<ApprovalItem> {
  if (item.status !== "approved" || !(await isClaimed(home, APPROVALS_DIR, item.id))) return item;
  const used: ApprovalItem = { ...item, status: "used", used_at: now };
  await replaceRecord(home, APPROVALS_DIR, used);
  await audit(home, now, "engine", "approval.used", used, { note: "token was spent by a call that did not finish" });
  return used;
}

/** Lazy expiry (D62): an open item past `expires_at` becomes `expired` the first time anything reads it. */
async function expireIfDue(home: string, stored: ApprovalItem, now: string): Promise<ApprovalItem> {
  const item = await settleSpent(home, stored, now);
  const open = item.status === "pending" || item.status === "approved";
  if (!open || Date.parse(now) < Date.parse(item.expires_at)) return item;
  const expired: ApprovalItem = { ...item, status: "expired" };
  await replaceRecord(home, APPROVALS_DIR, expired);
  await audit(home, now, "engine", "approval.expired", expired);
  return expired;
}

/** Every item, expiring the overdue ones; urgent open items first (§11.7 fast path), then by id. */
export async function listApprovals(home: string, now: string): Promise<ApprovalItem[]> {
  const items: ApprovalItem[] = [];
  for (const item of await listRecords(home, APPROVALS_DIR, isApprovalItem)) items.push(await expireIfDue(home, item, now));
  const rank = (item: ApprovalItem): number => (item.urgent && item.status === "pending" ? 0 : 1);
  return items.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

export async function getApproval(home: string, id: number, now: string): Promise<ApprovalItem> {
  const item = await readRecord(home, APPROVALS_DIR, id, isApprovalItem);
  if (!item) throw new InputError(`No approval item ${id}`);
  return expireIfDue(home, item, now);
}

/** The decision maker is whoever names the MODE phase's decision maker; anyone else at the terminal is a member (D60). */
export function deciderFor(as: string | undefined, roles: Roles | undefined): Decider {
  const name = as?.trim() || "terminal";
  const isDecisionMaker = roles !== undefined && name.toLowerCase() === roles.decision_maker.trim().toLowerCase();
  return { name, role: isDecisionMaker ? "decision_maker" : "member" };
}

/** A decision attempt that is not allowed: audited, then refused (§11.9). */
export async function refuseDecision(home: string, item: ApprovalItem, by: string, reason: string, now: string, actor: "human" | "agent" = "human"): Promise<never> {
  await audit(home, now, actor, "approval.refused", item, { by, reason });
  throw new InputError(reason);
}

/** A pending item the decider's role may decide; `needs` raises the role when an edit raises the level. */
async function openForDecision(home: string, id: number, decider: Decider, now: string, needs: Role | null = null): Promise<ApprovalItem> {
  const item = await getApproval(home, id, now);
  if (item.status !== "pending") return refuseDecision(home, item, decider.name, `Approval item ${id} is ${item.status}, not pending`, now);
  const required = needs && roleAtLeast(needs, item.required_role) ? needs : item.required_role;
  if (!roleAtLeast(decider.role, required)) {
    return refuseDecision(home, item, decider.name, `Approval item ${id} is ${item.level} and needs the decision maker: run it again with --as <decision maker's name>`, now);
  }
  return item;
}

const newToken = (id: number): string => `${id}.${randomBytes(32).toString("hex")}`;

export async function approveItem(home: string, id: number, decider: Decider, now: string): Promise<ApprovalItem> {
  const item = await openForDecision(home, id, decider, now);
  const approved: ApprovalItem = { ...item, status: "approved", token: newToken(id), decision: { decision: "approved", by: decider.name, role: decider.role, at: now } };
  await replaceRecord(home, APPROVALS_DIR, approved);
  await audit(home, now, "human", "approval.approved", approved, { by: decider.name, role: decider.role });
  return approved;
}

/** Edit = the person's version of the action, approved as edited: new hash, new level, the original kept (§11.5). */
export async function editItem(home: string, id: number, prepared: PreparedAction, decider: Decider, now: string): Promise<ApprovalItem> {
  const required = requiredRole(prepared.level) ?? "member";
  const item = await openForDecision(home, id, decider, now, required);
  if (prepared.tool !== item.action.tool) throw new InputError(`Approval item ${id} is for ${item.action.tool}; an edit can change its arguments, not the tool`);
  const edited: ApprovalItem = {
    ...item, status: "approved", token: newToken(id), level: prepared.level, required_role: required,
    action: { tool: prepared.tool, args: prepared.args }, expected_values: prepared.expected_values, action_hash: prepared.action_hash,
    decision: { decision: "edited", by: decider.name, role: decider.role, at: now, original: item.action },
  };
  await replaceRecord(home, APPROVALS_DIR, edited);
  await audit(home, now, "human", "approval.edited", edited, { by: decider.name, role: decider.role, original_hash: item.action_hash });
  return edited;
}

export async function rejectItem(home: string, id: number, decider: Decider, reason: string | undefined, now: string): Promise<ApprovalItem> {
  const item = await openForDecision(home, id, decider, now);
  const decision: Decision = { decision: "rejected", by: decider.name, role: decider.role, at: now, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
  const rejected: ApprovalItem = { ...item, status: "rejected", decision };
  await replaceRecord(home, APPROVALS_DIR, rejected);
  await audit(home, now, "human", "approval.rejected", rejected, { by: decider.name, reason: decision.reason ?? null });
  return rejected;
}

function sameToken(stored: string, given: string): boolean {
  const [a, b] = [Buffer.from(stored), Buffer.from(given)];
  return a.length === b.length && timingSafeEqual(a, b);
}

const NOT_USABLE: Readonly<Record<ApprovalStatus, string>> = {
  pending: "is not approved yet",
  approved: "is approved",
  rejected: "was rejected",
  expired: "has expired; request a new approval",
  used: "was already used; request a new approval",
};

/**
 * §11.1: the token exists, is approved, not expired, approved by a sufficient role, for exactly this action hash.
 * It is spent (an exclusive claim) before the tool runs, so it can never run twice, even after a crash (D58).
 */
export async function redeemToken(home: string, token: string, prepared: PreparedAction, now: string): Promise<ApprovalItem> {
  const id = Number(TOKEN_PATTERN.exec(token)?.[1] ?? 0);
  const found = id > 0 ? await readRecord(home, APPROVALS_DIR, id, isApprovalItem) : null;
  if (!found?.token || !sameToken(found.token, token)) throw new ToolRefusal("The approval_token does not match any approval");
  const item = await expireIfDue(home, found, now);
  if (item.status !== "approved") throw new ToolRefusal(`Approval ${id} ${NOT_USABLE[item.status]}`);
  if (item.action_hash !== prepared.action_hash) throw new ToolRefusal(`This call differs from approval ${id} (the tool, its arguments or the current values changed); request a new approval`);
  const required = requiredRole(prepared.level);
  if (required && item.decision && !roleAtLeast(item.decision.role, required)) throw new ToolRefusal(`${prepared.tool} is now ${prepared.level}; approval ${id} was given by a ${item.decision.role}; request a new approval`);
  if (!(await claimOnce(home, APPROVALS_DIR, id))) throw new ToolRefusal(`Approval ${id} ${NOT_USABLE.used}`);
  const used: ApprovalItem = { ...item, status: "used", used_at: now };
  await replaceRecord(home, APPROVALS_DIR, used);
  return used;
}
