import { join } from "node:path";
import { ToolRefusal, listApprovals, type ApprovalItem } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { roleAtLeast } from "./levels.js";
import { listMembers, type Member } from "./members.js";
import { createRecord, listRecords, readRecord, replaceRecord } from "./numbered.js";
import { GATEWAY_MARK } from "./channel-tools.js";
import { announcement, canDecideThere, tellEach } from "./reply-codes.js";
import { invokeTool, type ToolContext } from "./tools.js";
import type { Roles } from "./types.js";

/**
 * Urgent events and reminders (spec §11.7, D26, D95, D96). A judge whose schema declares a boolean `urgent` field
 * and answers `true` raises an urgent alert: an internal message (L1) to the decision maker on every channel they
 * joined, at once, repeated every ALERT_REPEAT_MS until they acknowledge it (`K<id>` from a verified channel, or
 * `taskpilot alerts ack <id>`), at most ALERT_MAX_SENDS times. The run becomes urgent: its approval items go first,
 * are reminded every URGENT_REMINDER_MS, and earned autonomy never approves them; anything external still needs a
 * person. Other pending approvals get one reminder REMINDER_AFTER_MS after they were asked, before they expire.
 */
export const ALERTS_DIR = join("state", "alerts");
export const REMINDERS_DIR = join("state", "gateway", "reminded");
export const ALERT_REPEAT_MS = 10 * 60 * 1000;
export const ALERT_MAX_SENDS = 6;
export const URGENT_REMINDER_MS = 5 * 60 * 1000;
export const URGENT_MAX_REMINDERS = 3;
export const REMINDER_AFTER_MS = 12 * 60 * 60 * 1000;

export type Alert = {
  readonly id: number;
  readonly workflow: string;
  readonly run_id: string;
  readonly step: string;
  /** What the model said: only the schema's declared fields, each line quoted with "> " (never the engine's words). */
  readonly text: string;
  readonly created_at: string;
  readonly sends: number;
  /** Urgent judgments of the workflow this open alert stands for: while it is open, more count here and send nothing. */
  readonly count: number;
  readonly last_sent: string;
  readonly acknowledged_by?: string;
  readonly acknowledged_at?: string;
};

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isAlert = (value: unknown): value is Alert => isRecord(value) && typeof value.id === "number" && typeof value.text === "string" && typeof value.sends === "number";
const isDomainError = (error: unknown): boolean => error instanceof InputError || error instanceof ToolRefusal || error instanceof ActionFailure;

async function notifyDecisionMaker(ctx: ToolContext, roles: Roles | undefined, text: string): Promise<string | null> {
  if (!roles) return "no decision maker is set (MODE phase)";
  try {
    // The engine's own words carry the installer's mark, which only the gateway's voice may use (never an agent's call).
    await invokeTool({ ...ctx, via: "gateway" }, "channel.notify", { member: roles.decision_maker, text });
    return null;
  } catch (error) {
    if (!isDomainError(error)) throw error;
    return (error as Error).message;
  }
}

type AlertRef = { readonly workflow: string; readonly run_id: string; readonly step: string };
const where = (ref: AlertRef): string => `Workflow '${ref.workflow}' (step '${ref.step}', run ${ref.run_id}) found something urgent.`;
const saying = (said: string): string => `\nThe model says:\n${said}`;

/**
 * The model's answers, labelled as its words: only the fields the recipe's schema declares, one per line, each value
 * as JSON (a string stays quoted and on its line) after "> ", so nothing it wrote reads as the engine's instructions.
 */
function modelSays(fields: readonly string[], answers: readonly unknown[]): string {
  const lines = answers.flatMap((answer) => (isRecord(answer) ? fields.filter((field) => Object.hasOwn(answer, field)).map((field) => `> ${field}: ${JSON.stringify(answer[field])}`) : []));
  return lines.join("\n").slice(0, 600);
}

async function sendAlert(ctx: ToolContext, roles: Roles | undefined, alert: Alert): Promise<Alert> {
  const counted = alert.count > 1 ? ` (${alert.count} urgent judgments so far)` : "";
  const error = await notifyDecisionMaker(ctx, roles, `${GATEWAY_MARK} URGENT (alert ${alert.id}): ${where(alert)}${counted} Reply K${alert.id} to acknowledge, or run 'taskpilot alerts ack ${alert.id}'.${saying(alert.text)}`);
  const sent: Alert = { ...alert, sends: alert.sends + 1, last_sent: ctx.now() };
  await replaceRecord(ctx.home, ALERTS_DIR, sent);
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "engine", event: "alert.sent", ref: `alert:${alert.id}`, payload: { run: `${alert.workflow}/${alert.run_id}`, sends: sent.sends, delivered: error === null, ...(error ? { error } : {}) } });
  return sent;
}

/** Another urgent judgment while the workflow's alert is still open: counted on that alert, never sent again (D95). */
async function countOn(ctx: ToolContext, open: Alert, ref: AlertRef): Promise<void> {
  const counted: Alert = { ...open, count: open.count + 1 };
  await replaceRecord(ctx.home, ALERTS_DIR, counted);
  await appendAudit(ctx.home, { ts: ctx.now(), actor: "engine", event: "alert.counted", ref: `alert:${open.id}`, payload: { run: `${ref.workflow}/${ref.run_id}`, count: counted.count } });
}

/**
 * An urgent judgement: the decision maker hears of it now, unless the workflow's last alert is still unacknowledged
 * (then it is counted there, so outside senders cannot flood them). In a sandbox run the message is recorded and
 * nothing repeats.
 */
export async function raiseAlert(ctx: ToolContext, roles: Roles | undefined, ref: AlertRef, said: { fields: readonly string[]; answers: readonly unknown[] }): Promise<void> {
  const text = modelSays(said.fields, said.answers);
  if (ctx.sandbox) {
    await notifyDecisionMaker(ctx, roles, `${GATEWAY_MARK} URGENT (sandbox): ${where(ref)}${saying(text)}`);
    return;
  }
  const open = (await listRecords(ctx.home, ALERTS_DIR, isAlert)).find((alert) => alert.workflow === ref.workflow && !alert.acknowledged_at);
  if (open) return countOn(ctx, open, ref);
  const alert = await createRecord<Alert>(ctx.home, ALERTS_DIR, (id) => ({ id, ...ref, text, created_at: ctx.now(), sends: 0, count: 1, last_sent: ctx.now() }));
  await sendAlert(ctx, roles, alert);
}

/** The tick: alerts nobody acknowledged go out again, every ALERT_REPEAT_MS, up to ALERT_MAX_SENDS sends. */
export async function repeatAlerts(ctx: ToolContext, roles: Roles | undefined): Promise<number> {
  const due = (await listRecords(ctx.home, ALERTS_DIR, isAlert)).filter((alert) => !alert.acknowledged_at && alert.sends < ALERT_MAX_SENDS && Date.parse(ctx.now()) - Date.parse(alert.last_sent) >= ALERT_REPEAT_MS);
  for (const alert of due) await sendAlert(ctx, roles, alert);
  return due.length;
}

export async function acknowledgeAlert(home: string, id: number, by: string, now: string): Promise<Alert> {
  const alert = await readRecord(home, ALERTS_DIR, id, isAlert);
  if (!alert) throw new InputError(`No urgent alert ${id}`);
  if (alert.acknowledged_at) return alert;
  const acknowledged: Alert = { ...alert, acknowledged_by: by, acknowledged_at: now };
  await replaceRecord(home, ALERTS_DIR, acknowledged);
  await appendAudit(home, { ts: now, actor: "human", event: "alert.acknowledged", ref: `alert:${id}`, payload: { by } });
  return acknowledged;
}

/** `K<id>` from a joined member: only the decision maker acknowledges (the alert is theirs, D26). */
export async function acknowledgeByReply(ctx: ToolContext, member: Member, id: number): Promise<string> {
  if (member.role !== "decision_maker") return `Urgent alert ${id} is acknowledged by the decision maker; it was not acknowledged`;
  try {
    await acknowledgeAlert(ctx.home, id, member.name, ctx.now());
    return `Urgent alert ${id} is acknowledged.`;
  } catch (error) {
    if (error instanceof InputError) return error.message;
    throw error;
  }
}

/** How often an item is reminded, and when: urgent ones every few minutes, others once, half way to expiry. */
function reminderDue(item: ApprovalItem, sent: { count: number; last: string }, now: string): boolean {
  const since = Date.parse(now) - Date.parse(sent.last);
  if (item.urgent) return sent.count < URGENT_MAX_REMINDERS && since >= URGENT_REMINDER_MS;
  return sent.count === 0 && since >= REMINDER_AFTER_MS;
}

/** The tick: reminds the members who may decide each pending item (D62, D78 deferred to Plan 8). */
export async function remindApprovals(ctx: ToolContext): Promise<number[]> {
  const members = (await listMembers(ctx.home, ctx.now())).filter((member) => member.status === "joined" && canDecideThere(member));
  const reminded: number[] = [];
  for (const item of (await listApprovals(ctx.home, ctx.now())).filter((entry) => entry.status === "pending")) {
    const file = join(REMINDERS_DIR, `${item.id}.json`);
    const sent = ((await readConfig(ctx.home, file)) as { count: number; last: string } | null) ?? { count: 0, last: item.created_at };
    const targets = members.filter((member) => roleAtLeast(member.role, item.required_role));
    if (targets.length === 0 || !reminderDue(item, sent, ctx.now())) continue;
    await tellEach(ctx, item, targets, announcement(item).replace(GATEWAY_MARK, `${GATEWAY_MARK} Reminder:`));
    await writeConfig(ctx.home, file, { count: sent.count + 1, last: ctx.now() });
    await appendAudit(ctx.home, { ts: ctx.now(), actor: "engine", event: "approval.reminded", ref: `approval:${item.id}`, payload: { id: item.id, urgent: item.urgent, count: sent.count + 1 } });
    reminded.push(item.id);
  }
  return reminded;
}

/** `taskpilot alerts [list | ack <id>]`: acknowledging is a person's act, in their own terminal (an agent cannot silence an alert). */
export async function alertsCommand(home: string, sub: string | undefined, id: string | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "list") return { alerts: await listRecords(home, ALERTS_DIR, isAlert) };
  if (!person.interactive) throw new InputError("An urgent alert is acknowledged by a person: run 'taskpilot alerts ack <id>' in your own terminal, or reply K<id>");
  if (sub === "ack" && id !== undefined && /^[1-9]\d*$/.test(id)) return { status: "acknowledged", alert: await acknowledgeAlert(home, Number(id), person.as?.trim() || "terminal", now()) };
  throw new InputError("alerts takes: list, ack <alert id>");
}
