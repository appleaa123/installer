import { join } from "node:path";
import { ToolRefusal } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { CHANNEL_IDS, type ChannelId } from "./channels.js";
import { MINUTE_MS, cronTimes, isTimeZone, wallClock } from "./cron.js";
import { readConfig, writeConfig } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { REPORT_RUNS, auditRun, claimRun, listRuns, recordMissed, runForKey, runIdFor, saveRun, type OnDamaged, type RunRecord } from "./runs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { MAX_TEXT, invokeTool, toolContext } from "./tools.js";

/**
 * The twice-daily report (spec §10.3, D39, D40, D89). At 09:00 and 17:00 in each recipient's own time zone, one
 * internal message (`channel.notify`, L1, no approval, R6 until the install is finished) lists every run in the
 * window since the previous report: status, when, how long, actions taken, the approval it waits for, the run id.
 * The report is itself scheduled under the missed-run rule: a slot the runner reaches more than five minutes late is
 * recorded as missed and not sent (the host-back-online notice covers the gap). When the recipient's channel
 * fails, the report goes to their fallback channel, and the failure is kept in the report's run record.
 */
export const REPORT_CONFIG = join("config", "report.json");
export const DEFAULT_TIMES = ["09:00", "17:00"];
export const REPORT_TOLERANCE_MS = 5 * MINUTE_MS;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ICONS: Readonly<Record<RunRecord["status"], string>> = { completed: "✅", partial: "⚠️", failed: "⛔", missed: "⏭", waiting: "⏸", running: "⏳" };

export interface Recipient {
  readonly member: string;
  readonly tz: string;
  readonly channel?: ChannelId;
  readonly fallback_channel?: ChannelId;
}

export interface ReportConfig {
  readonly recipients: readonly Recipient[];
  readonly times: readonly string[];
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const USAGE = `{"recipients":[{"member":"<name of a joined member>","tz":"<IANA time zone>","channel":"telegram","fallback_channel":"email"}],"times":["09:00","17:00"]}`;

function channelOf(value: unknown, where: string): ChannelId | undefined {
  if (value === undefined) return undefined;
  if (!(CHANNEL_IDS as readonly unknown[]).includes(value)) throw new InputError(`report: ${where} must be one of ${CHANNEL_IDS.join(", ")}`);
  return value as ChannelId;
}

function parseRecipient(value: unknown, index: number): Recipient {
  const where = `recipients[${index}]`;
  if (!isRecord(value) || typeof value.member !== "string" || value.member.trim() === "") throw new InputError(`report: ${where} needs 'member', the name of a member who joined with installer invite`);
  if (typeof value.tz !== "string" || !isTimeZone(value.tz)) throw new InputError(`report: ${where}.tz must be an IANA time zone, for example America/Toronto`);
  const [channel, fallback] = [channelOf(value.channel, `${where}.channel`), channelOf(value.fallback_channel, `${where}.fallback_channel`)];
  return { member: value.member.trim(), tz: value.tz, ...(channel ? { channel } : {}), ...(fallback ? { fallback_channel: fallback } : {}) };
}

export function parseReportConfig(value: unknown): ReportConfig {
  if (!isRecord(value) || !Array.isArray(value.recipients) || value.recipients.length === 0) throw new InputError(`report needs ${USAGE}`);
  const times = value.times ?? DEFAULT_TIMES;
  if (!Array.isArray(times) || times.length === 0 || !times.every((time) => typeof time === "string" && TIME.test(time))) throw new InputError("report: times must list HH:MM times");
  return { recipients: value.recipients.map(parseRecipient), times: [...new Set(times as string[])].sort() };
}

export async function loadReportConfig(home: string): Promise<ReportConfig | null> {
  const raw = await readConfig(home, REPORT_CONFIG);
  return raw === null ? null : parseReportConfig(raw);
}

/** `installer schedule report --value <json>`: who gets the report, in which zone, on which channel. */
export async function saveReportConfig(home: string, value: string | undefined, now: string): Promise<Record<string, unknown>> {
  if (value === undefined) return { report: await loadReportConfig(home) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InputError(`schedule report: --value must be JSON, ${USAGE}`);
  }
  const config = parseReportConfig(parsed);
  await writeConfig(home, REPORT_CONFIG, config);
  await appendAudit(home, { ts: now, actor: "agent", event: "report.configured", ref: REPORT_CONFIG, payload: config });
  return { status: "saved", report: config };
}

/** The recipient's report times in (after, until], as UTC instants. */
export function reportSlots(config: ReportConfig, recipient: Recipient, after: string, until: string): string[] {
  const all = config.times.flatMap((time) => {
    const [, hour, minute] = TIME.exec(time) ?? [];
    return cronTimes(`${Number(minute)} ${Number(hour)} * * *`, recipient.tz, after, until);
  });
  return [...new Set(all)].sort();
}

function line(record: RunRecord, tz: string): string {
  const when = wallClock(record.trigger.scheduled_for ?? record.started_at, tz);
  const took = record.finished_at && record.status !== "missed" ? (Date.parse(record.finished_at) - Date.parse(record.started_at)) / 1000 : null;
  const parts = [
    `${ICONS[record.status]} ${record.workflow} · ${when} · ${record.status === "missed" ? "skipped (missed)" : record.status}${took === null ? "" : ` in ${Math.floor(took / 60)}m ${String(Math.round(took % 60)).padStart(2, "0")}s`}`,
    ...(record.trigger.kind === "cron" ? [] : [`${record.trigger.kind} run`]),
    ...(record.actions > 0 ? [`${record.actions} action${record.actions === 1 ? "" : "s"}`] : []),
    ...(record.needs_human > 0 ? [`${record.needs_human} need a person`] : []),
    ...(record.waiting_on !== undefined ? [`awaiting approval #${record.waiting_on}`] : []),
  ];
  return `${parts.join(" · ")}\n   run: ${record.run_id}`;
}

/** The report's text: every run (not the reports themselves) whose time falls in (previous, slot]. */
export async function composeReport(home: string, recipient: Recipient, previous: string, slot: string, damaged?: OnDamaged): Promise<string> {
  const inWindow = (await listRuns(home, undefined, damaged)).filter((record) => record.workflow !== REPORT_RUNS).filter((record) => {
    const at = record.trigger.scheduled_for ?? record.started_at;
    return at > previous && at <= slot;
  });
  const header = `Report ${wallClock(previous, recipient.tz)} → ${wallClock(slot, recipient.tz)} (${recipient.tz}): ${inWindow.length} run${inWindow.length === 1 ? "" : "s"}.`;
  const text = [header, ...(inWindow.length === 0 ? ["No runs in this window."] : inWindow.map((record) => line(record, recipient.tz)))].join("\n");
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 60)}\n… more runs: see installer schedule list`;
}

const isDomainError = (error: unknown): error is Error => error instanceof InputError || error instanceof ToolRefusal || error instanceof ActionFailure;

async function deliverReport(home: string, now: () => string, recipient: Recipient, text: string): Promise<string | null> {
  const ctx = await toolContext(home, "runner", DEFAULT_TOOLS, now);
  const send = (channel: ChannelId | undefined) => invokeTool(ctx, "channel.notify", { member: recipient.member, text, ...(channel ? { channel } : {}) });
  try {
    await send(recipient.channel);
    return null;
  } catch (error) {
    if (!isDomainError(error) || !recipient.fallback_channel) throw error;
    await send(recipient.fallback_channel);
    return `sent on the fallback channel ${recipient.fallback_channel}; the ${recipient.channel ?? "usual"} channel failed: ${error.message}`;
  }
}

async function sendReport(home: string, now: () => string, recipient: Recipient, key: string, slot: string, previous: string, damaged?: OnDamaged): Promise<RunRecord | null> {
  const start: RunRecord = { workflow: REPORT_RUNS, run_id: runIdFor(key, slot), key, trigger: { kind: "report", scheduled_for: slot }, version: 1, status: "running", started_at: now(), sandbox: false, pid: process.pid, actions: 0, needs_human: 0 };
  if (!(await claimRun(home, start))) return null;
  let done: RunRecord;
  try {
    const note = await deliverReport(home, now, recipient, await composeReport(home, recipient, previous, slot, damaged));
    done = { ...start, status: "completed", finished_at: now(), actions: 1, ...(note ? { reason: note } : {}) };
  } catch (error) {
    if (!isDomainError(error)) throw error;
    done = { ...start, status: "failed", finished_at: now(), reason: error.message };
  }
  await saveRun(home, done);
  await auditRun(home, now(), "report.finished", done, { member: recipient.member, ...(done.reason ? { reason: done.reason } : {}) });
  return done;
}

/** Called by the tick: each recipient's slots since the last heartbeat; sent when on time, missed otherwise. */
export async function dueReports(home: string, now: () => string, at: string, last: string | null, damaged?: OnDamaged): Promise<{ sent: RunRecord[]; missed: RunRecord[] }> {
  const config = await loadReportConfig(home);
  const result = { sent: [] as RunRecord[], missed: [] as RunRecord[] };
  if (!config) return result;
  const window = new Date(Date.parse(at) - REPORT_TOLERANCE_MS).toISOString();
  const after = new Date(Date.parse(last !== null && last < window ? last : window) - 1).toISOString();
  for (const recipient of config.recipients) {
    for (const slot of reportSlots(config, recipient, after, at)) {
      const key = `report:${recipient.member.toLowerCase()}:${slot}`;
      if (await runForKey(home, key)) continue;
      if (Date.parse(at) - Date.parse(slot) > REPORT_TOLERANCE_MS) {
        const missed = await recordMissed(home, REPORT_RUNS, 1, key, slot, at);
        if (missed) result.missed.push(missed);
        continue;
      }
      const previous = reportSlots(config, recipient, new Date(Date.parse(slot) - 2 * 24 * 60 * MINUTE_MS).toISOString(), new Date(Date.parse(slot) - MINUTE_MS).toISOString()).at(-1) ?? slot;
      const sent = await sendReport(home, now, recipient, key, slot, previous, damaged);
      if (sent) result.sent.push(sent);
    }
  }
  return result;
}
