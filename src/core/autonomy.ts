import { join } from "node:path";
import { ToolRefusal, approveItem, deciderFor, listApprovals, type ApprovalItem, type PreparedAction } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { StateCorruptError } from "./state.js";
import { invokeTool, type ToolContext } from "./tools.js";
import type { Roles } from "./types.js";

/**
 * Earned autonomy (spec §11.6, D25, D94). An action type is one typed `tool` step of one workflow: workflow, step and
 * tool, so its arguments come from a fixed template, never from a model choosing freely. After AUTONOMY_STREAK
 * approvals of that type in a row, each by a person and none edited, the runner tells the decision maker once; the
 * decision maker may grant it in their own terminal (`taskfollow autonomy grant`, a policy change, audited). What a
 * grant changes, and nothing else: when such a step asks for approval and the level the gate derives at that moment
 * is L2 only because of the tool's declared or default level, the runner approves the item itself, as
 * "earned autonomy (grant <id>)" with the member role. The item, its exact action hash, its single-use token and its
 * audit lines are unchanged. Never for L3 (the floor, financial or protected fields), a client rule, an approve step,
 * an agent's call, an urgent run or a call from the agent's chat. Any later edit or rejection of that type by a
 * person revokes the grant automatically.
 */
export const AUTONOMY_FILE = join("config", "autonomy.json");
export const AUTONOMY_STREAK = 25;
export const AUTONOMY_DECIDER = "earned autonomy";
const OWN_LEVEL = /^(declared L2|no declared level \(default L2\))$/;

export interface Grant {
  readonly id: number;
  readonly type: string;
  readonly granted_by: string;
  readonly at: string;
  readonly streak: number;
  readonly status: "active" | "revoked";
  readonly revoked_at?: string;
  readonly revoked_reason?: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** `<workflow>/<step>/<tool>` of an item a typed tool step asked for; null for every other item. */
export function actionType(item: ApprovalItem): string | null {
  const run = item.source.run;
  return item.source.via === "runner" && run?.policy === true ? `${run.workflow}/${run.step}/${item.action.tool}` : null;
}

const byPerson = (item: ApprovalItem): boolean => item.decision !== undefined && !item.decision.by.startsWith(AUTONOMY_DECIDER);

async function loadGrants(home: string): Promise<Grant[]> {
  const raw = await readConfig(home, AUTONOMY_FILE);
  if (raw === null) return [];
  if (!isRecord(raw) || !Array.isArray(raw.grants)) throw new StateCorruptError(`${AUTONOMY_FILE} has an unexpected shape; it was not changed`);
  return raw.grants as Grant[];
}

const saveGrants = (home: string, grants: readonly Grant[]): Promise<void> => writeConfig(home, AUTONOMY_FILE, { grants });

/** Approvals of this type by a person, in a row, none edited; an edit or a rejection starts again from zero. */
export function streakOf(items: readonly ApprovalItem[], type: string): number {
  return [...items].filter((item) => actionType(item) === type && byPerson(item)).sort((a, b) => a.id - b.id)
    .reduce((count, item) => (item.decision?.decision === "approved" ? count + 1 : 0), 0);
}

/** Only an L2 that comes from the tool itself: never L3, never a client rule (§11.3, D24). */
export const ownL2 = (prepared: PreparedAction): boolean => prepared.level === "L2" && prepared.reasons.length > 0 && prepared.reasons.every((reason) => OWN_LEVEL.test(reason));

async function revoke(home: string, grants: readonly Grant[], grant: Grant, reason: string, by: string, now: string): Promise<Grant> {
  const revoked: Grant = { ...grant, status: "revoked", revoked_at: now, revoked_reason: reason };
  await saveGrants(home, grants.map((entry) => (entry.id === grant.id ? revoked : entry)));
  await appendAudit(home, { ts: now, actor: by === "engine" ? "engine" : "human", event: "autonomy.revoked", ref: `autonomy:${grant.id}`, payload: { type: grant.type, by, reason } });
  return revoked;
}

/** The active grant of this type; one that a person's later edit or rejection undid is revoked now (lazily, like expiry). */
export async function activeGrant(home: string, type: string, now: string): Promise<Grant | null> {
  const grants = await loadGrants(home);
  const grant = grants.find((entry) => entry.type === type && entry.status === "active");
  if (!grant) return null;
  const undone = (await listApprovals(home, now)).find((item) => actionType(item) === type && byPerson(item) && item.decision?.decision !== "approved" && (item.decision?.at ?? "") > grant.at);
  if (!undone) return grant;
  await revoke(home, grants, grant, `a person ${undone.decision?.decision ?? "decided"} approval ${undone.id}`, "engine", now);
  return null;
}

/** Approves the item for its grant when everything above holds; true when it did. */
export async function approveByGrant(home: string, item: ApprovalItem, prepared: PreparedAction, urgent: boolean, now: string): Promise<boolean> {
  const type = actionType(item);
  if (type === null || urgent || item.urgent || !ownL2(prepared)) return false;
  const grant = await activeGrant(home, type, now);
  if (!grant) return false;
  await approveItem(home, item.id, { name: `${AUTONOMY_DECIDER} (grant ${grant.id})`, role: "member" }, now);
  return true;
}

/** The runner proposes (§11.6): one notice to the decision maker when a type reaches the streak. */
export async function proposeIfEarned(ctx: ToolContext, roles: Roles | undefined, item: ApprovalItem): Promise<void> {
  const type = actionType(item);
  if (type === null || item.level !== "L2" || (await activeGrant(ctx.home, type, ctx.now()))) return;
  if (streakOf(await listApprovals(ctx.home, ctx.now()), type) !== AUTONOMY_STREAK) return;
  const text = `${AUTONOMY_STREAK} approvals in a row, none edited, for ${type}. The decision maker may let the runner approve it from now on: 'taskfollow autonomy grant ${type} --as <your name>' in your own terminal.`;
  let error: string | null = roles ? null : "no decision maker is set (MODE phase)";
  if (roles) {
    try {
      await invokeTool(ctx, "channel.notify", { member: roles.decision_maker, text });
    } catch (failure) {
      if (!(failure instanceof InputError || failure instanceof ToolRefusal || failure instanceof ActionFailure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "engine", event: "autonomy.proposed", ref: type, payload: { streak: AUTONOMY_STREAK, delivered: error === null, ...(error ? { error } : {}) } });
}

async function grantType(home: string, type: string, by: string, now: string): Promise<Grant> {
  const items = (await listApprovals(home, now)).filter((item) => actionType(item) === type);
  const streak = streakOf(items, type);
  if (streak < AUTONOMY_STREAK) throw new InputError(`${type} has ${streak} approvals in a row by a person; a grant needs ${AUTONOMY_STREAK}`);
  if (items.at(-1)?.level !== "L2") throw new InputError(`${type} is not L2; earned autonomy never applies to L3 (§11.3)`);
  const grants = await loadGrants(home);
  if (grants.some((entry) => entry.type === type && entry.status === "active")) throw new InputError(`${type} already has an active grant`);
  const grant: Grant = { id: grants.length + 1, type, granted_by: by, at: now, streak, status: "active" };
  await saveGrants(home, [...grants, grant]);
  await appendAudit(home, { ts: now, actor: "human", event: "autonomy.granted", ref: `autonomy:${grant.id}`, payload: { type, by, streak, category: "policy_change" } });
  return grant;
}

/** `taskfollow autonomy [list | grant <type> | revoke <id>]`: grants and revokes are the decision maker's, in a terminal. */
export async function autonomyCommand(home: string, roles: Roles | undefined, command: { sub?: string; arg?: string; as?: string; reason?: string; interactive: boolean }, now: () => string): Promise<Record<string, unknown>> {
  const items = await listApprovals(home, now());
  if (command.sub === undefined || command.sub === "list") {
    const types = [...new Set(items.map(actionType).filter((type): type is string => type !== null))];
    return { streak_needed: AUTONOMY_STREAK, types: types.map((type) => ({ type, streak: streakOf(items, type) })), grants: await loadGrants(home) };
  }
  if (!command.interactive) throw new InputError("Granting or revoking earned autonomy is a policy change: the decision maker runs it in their own terminal");
  const decider = deciderFor(command.as, roles);
  if (decider.role !== "decision_maker") throw new InputError("Only the decision maker changes earned autonomy: run it again with --as <decision maker's name>");
  if (command.sub === "grant" && command.arg) return { status: "granted", grant: await grantType(home, command.arg, decider.name, now()) };
  const grants = await loadGrants(home);
  const grant = grants.find((entry) => String(entry.id) === command.arg && entry.status === "active");
  if (command.sub === "revoke" && grant) return { status: "revoked", grant: await revoke(home, grants, grant, command.reason?.trim() || "revoked by the decision maker", decider.name, now()) };
  throw new InputError("autonomy takes: list, grant <workflow>/<step>/<tool>, revoke <active grant id>");
}
