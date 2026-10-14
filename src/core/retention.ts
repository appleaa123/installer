import { SETTINGS_BACKUP_DIR } from "./watch.js";
import { CALLS_DIR } from "./watch-record.js";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { SENT_DIR } from "./channel-policy.js";
import { readConfig, writeConfig } from "./data-source.js";
import { SEEN_DIR } from "./inbound.js";
import { removeAttachments } from "./attachments.js";
import { INBOX_DIR, rememberContact } from "./inbox.js";
import { InputError } from "./inputs.js";
import { listRecords, removeRecord } from "./numbered.js";
import { OUTBOX_DIR } from "./outbound.js";
import { FINISHED, listRuns, removeRun } from "./runs.js";
import { StateCorruptError } from "./state.js";

/**
 * Retention (spec §14.5, D86, D102). Raw operational data is kept for a configurable number of days (default 90):
 * finished run logs with their idempotency keys, inbound messages, recordings in the sink, sent-message counts and
 * the gateway's seen-message markers. The audit is never pruned: it is the record of who did what, and it is
 * exported instead (`taskfollow uninstall`). Business records live in the client's own systems and are never touched.
 * A longer period may be set from anywhere; a shorter one deletes data sooner, so only a person, in a terminal (D61).
 */
export const RETENTION_FILE = join("config", "retention.json");
export const DEFAULT_RETENTION_DAYS = 90;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Retention {
  readonly days: number;
  readonly at?: string;
  readonly by?: string;
}

export interface Pruned {
  readonly runs: number;
  readonly inbox: number;
  readonly recordings: number;
  readonly sent: number;
  readonly seen: number;
  /** D146: the record of the agent's direct calls, and copies of the Claude Code settings taken before a change. */
  readonly direct_calls: number;
  readonly settings_backups: number;
}

type Raw = Record<string, unknown>;
type Numbered = { readonly id: number } & Raw;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isNumbered = (value: unknown): value is Numbered => isRecord(value) && typeof value.id === "number";
const validDays = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= MIN_RETENTION_DAYS && value <= MAX_RETENTION_DAYS;

export async function loadRetention(home: string): Promise<Retention> {
  const raw = await readConfig(home, RETENTION_FILE);
  if (raw === null) return { days: DEFAULT_RETENTION_DAYS };
  if (!isRecord(raw) || !validDays(raw.days)) throw new StateCorruptError(`${RETENTION_FILE} has an unexpected shape; remove it and set the period again with 'taskfollow retention --value <days>'`);
  return raw as unknown as Retention;
}

function parseDays(value: string): number {
  const days = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!validDays(days)) throw new InputError(`retention --value must be a whole number of days from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}, for example --value 90`);
  return days;
}

/** `taskfollow retention [--value <days>]`: shows the period, or sets it; shortening it needs a person's terminal. */
export async function retentionCommand(home: string, value: string | undefined, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  const current = await loadRetention(home);
  if (value === undefined) return { retention: current, note: "Run logs, inbound messages and recordings older than this are deleted by 'taskfollow doctor'; the audit is never deleted" };
  const days = parseDays(value);
  if (days < current.days && !person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "retention.refused", ref: RETENTION_FILE, payload: { from: current.days, to: days } });
    throw new InputError(`A shorter period deletes data sooner: the person runs 'taskfollow retention --value ${days}' in their own terminal`);
  }
  const next: Retention = { days, at: now(), by: person.interactive ? person.as?.trim() || "terminal" : "agent" };
  await writeConfig(home, RETENTION_FILE, next);
  await appendAudit(home, { ts: now(), actor: person.interactive ? "human" : "agent", event: "retention.set", ref: RETENTION_FILE, payload: { from: current.days, to: days, by: next.by } });
  return { status: "saved", retention: next };
}

/** Finished runs that ended before the cutoff, each with its key (a damaged run record is left for `doctor` to name). */
async function pruneRuns(home: string, cutoff: string): Promise<number> {
  let count = 0;
  for (const record of await listRuns(home, undefined, async () => undefined)) {
    if (!FINISHED.includes(record.status) || (record.finished_at ?? record.started_at) >= cutoff) continue;
    await removeRun(home, record);
    count += 1;
  }
  return count;
}

/** Old numbered records go, except the newest of the folder, so new ids keep counting up (cursors compare ids). */
async function pruneNumbered(home: string, dir: string, field: string, cutoff: string, before?: (record: Numbered) => Promise<void>): Promise<number> {
  const records = await listRecords(home, dir, isNumbered);
  const newest = records.at(-1)?.id;
  let count = 0;
  for (const record of records) {
    const at = record[field];
    if (record.id === newest || typeof at !== "string" || at >= cutoff) continue;
    await before?.(record);
    if (await removeRecord(home, dir, record.id)) count += 1;
  }
  return count;
}

/** Marker files last changed before the cutoff. */
async function pruneFiles(home: string, dir: string, cutoffMs: number): Promise<number> {
  const folder = await confinedPath(home, dir);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const name of names) {
    if ((await stat(join(folder, name))).mtimeMs >= cutoffMs) continue;
    await rm(join(folder, name), { force: true });
    count += 1;
  }
  return count;
}

/** Deletes what is older than the period (run by `taskfollow doctor`); audited when anything went. Never the audit. */
export async function pruneOld(home: string, now: string): Promise<Pruned> {
  const { days } = await loadRetention(home);
  const cutoff = new Date(Date.parse(now) - days * DAY_MS).toISOString();
  const remember = async (item: Numbered): Promise<void> => {
    await removeAttachments(home, Array.isArray(item.attachments) ? item.attachments.filter((entry): entry is string => typeof entry === "string") : []);
    await rememberContact(home, { channel: String(item.channel), address: String(item.from) });
  };
  const pruned: Pruned = {
    runs: await pruneRuns(home, cutoff),
    inbox: await pruneNumbered(home, INBOX_DIR, "received_at", cutoff, remember),
    recordings: await pruneNumbered(home, OUTBOX_DIR, "at", cutoff),
    sent: await pruneNumbered(home, SENT_DIR, "at", cutoff),
    seen: await pruneFiles(home, SEEN_DIR, Date.parse(cutoff)),
    direct_calls: await pruneFiles(home, CALLS_DIR, Date.parse(cutoff)),
    settings_backups: await pruneFiles(home, SETTINGS_BACKUP_DIR, Date.parse(cutoff)),
  };
  if (Object.values(pruned).some((count) => count > 0)) await appendAudit(home, { ts: now, actor: "engine", event: "retention.pruned", ref: RETENTION_FILE, payload: { days, before: cutoff, ...pruned } });
  return pruned;
}
