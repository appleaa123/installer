import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { listApprovals } from "./approvals.js";
import { AUDIT_FILE, appendAudit, verifyAudit, withAuditLock } from "./audit.js";
import { listChannels } from "./channels.js";
import { loadReportConfig } from "./daily-report.js";
import { SOURCES_DIR, readConfig } from "./data-source.js";
import { loadDoctorReport } from "./doctor.js";
import { LOG_FILE } from "./gateway.js";
import { READINESS_FILE } from "./host.js";
import { INBOX_DIR } from "./inbox.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { personalFields } from "./learning.js";
import { listMembers } from "./members.js";
import { loadModelConfig } from "./model.js";
import { listIds } from "./numbered.js";
import { OUTBOX_DIR } from "./outbound.js";
import { loadPacks } from "./packs.js";
import { PAUSED_REASON, loadPause } from "./pause.js";
import { loadPinnedSolution } from "./pin.js";
import { buildReport } from "./report.js";
import { loadRetention } from "./retention.js";
import { MISSED_REASON, listRuns } from "./runs.js";
import { loadSandboxMode } from "./sandbox.js";
import { TICK_LOG } from "./scheduler.js";
import { loadState } from "./state.js";
import type { InstallState } from "./types.js";
import { ENGINE_SECRETS, EXPORTS_DIR } from "./uninstall.js";
import { installerVersion } from "./version.js";

/**
 * `taskfollow support bundle` (spec §16.5, D34, D110): one JSON file under `exports/` that the person reads and sends
 * to whoever supports their install; nothing is sent by the engine and there is no remote access. It holds the
 * install's shape (versions, step statuses, report, doctor and readiness findings, recent run summaries, settings,
 * counts, the audit check, the tails of the gateway and tick logs) and never a secret, a person's name or address,
 * a message, a record or an answer: answers are left out, settings are copied field by field, every member's name and
 * address, the decision maker, the sheet ids and the OS user's home folder are replaced wherever they appear, and so
 * are email addresses, long numbers and the values of fields the contract tags personal or protected_ground.
 */
const REDACTED = "[redacted]";
const LOG_LINES = 50;
const RECENT_RUNS = 20;
/** The tick's passes (tick.ts `guard`), whose name leads each error the tick logs. */
const TICK_PASSES: ReadonlySet<string> = new Set(["report", "events", "resume", "alerts", "learning", "doctor"]);
const RECENT_RUNS_DETAIL = "in the last 24 hours: runs that failed or were missed, or report fallbacks (see runs)";

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (values: readonly string[]): Record<string, number> => values.reduce<Record<string, number>>((all, value) => ({ ...all, [value]: (all[value] ?? 0) + 1 }), {});

/** Known names first, then emails, then numbers of seven digits or more (phones, accounts) that are not a date. */
function scrubText(text: string, known: readonly string[]): string {
  const named = known.reduce((out, value) => out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(value)}(?![\\p{L}\\p{N}])`, "giu"), REDACTED), text.split(homedir()).join("~"));
  const long = (match: string): boolean => match.replace(/\D/g, "").length >= 7 && !/^\d{4}-\d{2}-\d{2}/.test(match);
  return named.replace(/[^\s@"'()]+@[^\s@"'()]+\.[A-Za-z]{2,}\b/g, "[email]").replace(/\+?\d[\d\s().-]{5,}\d/g, (match) => (long(match) ? "[number]" : match));
}

export function scrub(value: unknown, known: readonly string[], fields: ReadonlySet<string>): unknown {
  if (typeof value === "string") return scrubText(value, known);
  if (Array.isArray(value)) return value.map((entry) => scrub(entry, known, fields));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, fields.has(key) ? REDACTED : scrub(entry, known, fields)]));
}

/** Names and addresses this home knows about, longest first, so a full name is replaced before a part of it. */
async function knownValues(home: string, state: InstallState, now: string): Promise<string[]> {
  const members = await listMembers(home, now);
  const channels = await listChannels(home);
  const report = await loadReportConfig(home);
  const values = [
    ...(state.roles ? [state.roles.decision_maker] : []), ...members.flatMap((member) => [member.name, ...(member.identity ? [member.identity.address] : [])]),
    ...channels.flatMap((config) => (config.channel === "email" ? [config.address, config.imap.user, config.smtp.user] : config.channel === "slack" ? [config.team, config.team_id, config.bot_user_id] : config.channel === "whatsapp" ? [config.relay_url, config.phone_number_id, config.display_number] : [config.bot.username])),
    ...(report?.recipients.map((recipient) => recipient.member) ?? []), ...(await sheetIds(home)),
  ];
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))].sort((a, b) => b.length - a.length);
}

/** The spreadsheet ids of the connected sources: they point at the client's own records. */
async function sheetIds(home: string): Promise<string[]> {
  const names = await readdir(await confinedPath(home, SOURCES_DIR)).catch(() => [] as string[]);
  const ids: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const source = (await readConfig(home, join(SOURCES_DIR, name))) as Raw | null;
    if (typeof source?.spreadsheet_id === "string") ids.push(source.spreadsheet_id);
  }
  return ids;
}

/**
 * An engine error message can hold an outside contact's name or a short chat id (the scrub cannot know them), so the
 * bundle keeps only a fixed category for it, never its text.
 */
export function errorCategory(text: string): string {
  if (text === PAUSED_REASON) return "paused";
  if (text === MISSED_REASON) return "missed";
  if (/^step '[^']*' failed: /.test(text)) return "step failed";
  if (/^approval \d+ is \w+$/.test(text)) return "approval";
  const pass = text.split(":")[0] ?? "";
  return text.includes(":") && TICK_PASSES.has(pass) ? pass : "error";
}

/** A gateway or tick log line (JSON) with each error message replaced by its category: error text can name an outside contact. */
function logLine(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  if (!isRecord(parsed)) return line;
  const errors = Array.isArray(parsed.errors) ? { errors: parsed.errors.map((error) => (typeof error === "string" ? errorCategory(error) : "error")) } : {};
  return JSON.stringify({ ...parsed, ...errors, ...(typeof parsed.error === "string" ? { error: errorCategory(parsed.error) } : {}) });
}

async function tail(home: string, relative: string): Promise<string[]> {
  const text = await readFile(await confinedPath(home, relative), "utf8").catch(() => "");
  return text.split("\n").filter((line) => line !== "").slice(-LOG_LINES);
}

/** The install state without any answer a person gave. */
const stateView = (state: InstallState) => ({
  solution: state.solution, started_at: state.started_at, mode: state.mode ?? null, runtime: state.runtime ?? null, work_dir: state.work_dir ?? null, audit_head: state.audit_head ?? null,
  steps: Object.fromEntries(Object.entries(state.steps).map(([id, { value: _answer, ...record }]) => [id, record])),
});

async function settings(home: string): Promise<Raw> {
  const channels = (await listChannels(home)).map((config) => ({ channel: config.channel, verified_at: config.verified_at, ...(config.channel === "email" ? { imap: { host: config.imap.host, port: config.imap.port, security: config.imap.security }, smtp: { host: config.smtp.host, port: config.smtp.port, security: config.smtp.security } } : {}) }));
  const model = await loadModelConfig(home);
  const report = await loadReportConfig(home);
  const packs = Object.fromEntries(Object.entries(await loadPacks(home)).map(([pack, pin]) => [pack, { version: pin.version, candidate: pin.candidate?.version ?? null }]));
  return {
    channels, model: model ? { provider: model.provider, model: model.model } : null, report: report ? { times: report.times, recipients: report.recipients.length } : null,
    sandbox: await loadSandboxMode(home), pause: await loadPause(home), retention: await loadRetention(home), packs,
  };
}

async function counts(home: string, now: string): Promise<Raw> {
  const members = await listMembers(home, now);
  return {
    approvals: count((await listApprovals(home, now)).map((item) => item.status)), members: count(members.map((member) => `${member.role} ${member.status}`)),
    inbox: (await listIds(home, INBOX_DIR)).length, recordings: (await listIds(home, OUTBOX_DIR)).length,
  };
}

async function runsView(home: string): Promise<Raw> {
  const runs = await listRuns(home, undefined, async () => undefined);
  const recent = runs.slice(-RECENT_RUNS).map((run) => ({ workflow: run.workflow, run_id: run.run_id, status: run.status, trigger: run.trigger.kind, started_at: run.started_at, finished_at: run.finished_at ?? null, sandbox: run.sandbox, actions: run.actions, needs_human: run.needs_human, reason: run.reason === undefined ? null : errorCategory(run.reason) }));
  return { by_status: count(runs.map((run) => run.status)), recent };
}

/** The doctor's findings; the recent runs' detail quotes run errors, so it becomes a fixed text (the runs section has them). */
async function doctorView(home: string): Promise<Raw | null> {
  const report = await loadDoctorReport(home);
  if (!report) return null;
  return { ...report, checks: report.checks.map((check) => (check.id === "recent_runs" && check.status !== "ok" ? { ...check, detail: RECENT_RUNS_DETAIL } : check)) };
}

async function auditView(home: string, state: InstallState): Promise<Raw> {
  const check = await withAuditLock(home, () => verifyAudit(home, state.audit_head));
  const lines = (await readFile(await confinedPath(home, AUDIT_FILE), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");
  return { check, events: count(lines.map((line) => String((JSON.parse(line) as Raw).event))) };
}

async function bundleOf(home: string, state: InstallState, now: string): Promise<Raw> {
  const { solution } = await loadPinnedSolution(home);
  const secrets = Object.fromEntries(await Promise.all(ENGINE_SECRETS.map(async (id) => [id, (await getSecret(id)) !== null])));
  return {
    format: 1, created_at: now, versions: { installer: await installerVersion(), node: process.version, platform: `${process.platform} ${process.arch}` },
    state: stateView(state), report: buildReport(solution, state), doctor: await doctorView(home), readiness: await readConfig(home, READINESS_FILE),
    runs: await runsView(home), settings: await settings(home), counts: await counts(home, now), audit: await auditView(home, state),
    secrets_present: secrets, logs: { gateway: (await tail(home, LOG_FILE)).map(logLine), tick: (await tail(home, TICK_LOG)).map(logLine) },
  };
}

/** `taskfollow support bundle`: writes the redacted file and says where it is; changes nothing else. */
export async function supportBundle(home: string, now: () => string): Promise<Record<string, unknown>> {
  const state = await loadState(home);
  if (!state) throw new InputError("No install found in this home; run 'taskfollow start --solution <ref>' first");
  const at = now();
  const known = await knownValues(home, state, at);
  const fields = personalFields((await loadPinnedSolution(home)).solution.data_contract ?? null);
  const bundle = scrub(await bundleOf(home, state, at), known, fields) as Raw;
  const file = await confinedPath(home, join(EXPORTS_DIR, `support-${at.replace(/[:.]/g, "-")}.json`));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await appendAudit(home, { ts: at, actor: "engine", event: "support.bundle_written", ref: EXPORTS_DIR, payload: { sections: Object.keys(bundle) } });
  return { status: "written", file, sections: Object.keys(bundle), note: "Read it first, then send this file yourself to whoever supports your install. It holds no secrets, names, addresses, messages or records (D110)." };
}
