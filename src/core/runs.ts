import { createHash } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit, canonicalJson } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { createExclusive } from "./durable.js";
import { StateCorruptError } from "./state.js";

/**
 * The run log (spec §10.6, D86): `runs/<workflow>/<run_id>/run.json` and `steps/<step_id>.json`, JSON files under
 * the engine home like every other store (D57: no `ops.sqlite`). Idempotency (§10.7, D17): every run has a key
 * (`<workflow>:<scheduled time>` for cron, `<workflow>:inbox:<id>` for an event, a fresh one for a manual run);
 * `state/runner/keys/<sha256(key)>` is created exclusively, so a key is claimed once, by one process, forever.
 * A claimed key that already has a run is never started again: a finished run is skipped, an unfinished one resumes
 * from its last completed step. Each start, step and finish is also an audit line (§11.8).
 */
export const RUNS_DIR = "runs";
export const KEYS_DIR = join("state", "runner", "keys");
export const RUN_STATUSES = ["running", "waiting", "completed", "partial", "failed", "missed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const FINISHED: readonly RunStatus[] = ["completed", "partial", "failed", "missed"];
/** Run folders that are not workflows (the twice-daily report, D89); a workflow id cannot start with `_`. */
export const REPORT_RUNS = "_report";

export interface RunTrigger {
  readonly kind: "cron" | "event" | "manual" | "report";
  readonly scheduled_for?: string;
  readonly inbox_id?: number;
  /** A dry run's synthetic sample message (D98), bound as `event` when no stored message matches the trigger. */
  readonly sample_event?: Readonly<Record<string, unknown>>;
}

export interface RunRecord {
  readonly workflow: string;
  readonly run_id: string;
  readonly key: string;
  readonly trigger: RunTrigger;
  readonly version: number;
  readonly status: RunStatus;
  readonly started_at: string;
  readonly finished_at?: string;
  readonly sandbox: boolean;
  readonly pid: number;
  /** Tool calls that changed something (L1 and up). */
  readonly actions: number;
  /** Judge answers that need a person (§10.9 uncertainty). */
  readonly needs_human: number;
  /** The approval item the run waits for. */
  readonly waiting_on?: number;
  readonly reason?: string;
  /** Drift (D18): the typed step that failed, after which this run fell back to the workflow's agent. */
  readonly fallback_from?: { readonly step: string; readonly error: string };
  /** A judge flagged something urgent (§11.7): approvals go first and are reminded often, and no grant approves them. */
  readonly urgent?: boolean;
}

export const STEP_STATUSES = ["done", "waiting", "rejected", "failed"] as const;

/** One call an agent step made (§10.8, D92): what the model asked for, the level the gate derived, and what happened. */
export interface AgentTurn {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly level?: string;
  readonly result?: unknown;
  readonly error?: string;
  readonly approval?: number;
}

export interface StepLog {
  readonly step: string;
  readonly status: (typeof STEP_STATUSES)[number];
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly input_fingerprint: string;
  readonly output?: unknown;
  readonly skipped?: boolean;
  readonly approval?: number;
  readonly context_calls?: readonly unknown[];
  readonly needs_human?: readonly { readonly index: number; readonly reason: string }[];
  readonly error?: string;
  /** Agent steps: the input the agent was given and every call it made, in order (the record hardening learns from). */
  readonly input?: unknown;
  readonly turns?: readonly AgentTurn[];
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** `sha256:` of the canonical JSON: what a step was given, without keeping it twice. */
export const fingerprint = (value: unknown): string => `sha256:${sha256(canonicalJson(value ?? null))}`;

/** `<date of the scheduled time or the start>-<8 hex of the key>`, for example 2026-10-08-1a2b3c4d. */
export const runIdFor = (key: string, at: string): string => `${at.slice(0, 10)}-${sha256(key).slice(0, 8)}`;

const runFile = (workflow: string, runId: string): string => join(RUNS_DIR, workflow, runId, "run.json");
const stepFile = (record: RunRecord, step: string): string => join(RUNS_DIR, record.workflow, record.run_id, "steps", `${step}.json`);
const keyFile = (key: string): string => join(KEYS_DIR, sha256(key));

function isRun(value: unknown): value is RunRecord {
  return isRecord(value) && typeof value.workflow === "string" && typeof value.run_id === "string" && typeof value.key === "string" && (RUN_STATUSES as readonly unknown[]).includes(value.status);
}

export async function loadRun(home: string, workflow: string, runId: string): Promise<RunRecord | null> {
  const raw = await readConfig(home, runFile(workflow, runId));
  if (raw === null) return null;
  if (!isRun(raw)) throw new StateCorruptError(`${runFile(workflow, runId)} has an unexpected shape; it was not changed`);
  return raw;
}

export const saveRun = (home: string, record: RunRecord): Promise<void> => writeConfig(home, runFile(record.workflow, record.run_id), record);

export async function auditRun(home: string, now: string, event: string, record: RunRecord, extra: Raw = {}): Promise<void> {
  await appendAudit(home, { ts: now, actor: "engine", event, ref: `run:${record.workflow}/${record.run_id}`, payload: { key: record.key, status: record.status, ...extra } });
}

/** The run a key was claimed for, or null when the key is free. */
export async function runForKey(home: string, key: string): Promise<RunRecord | null> {
  const claimed = await readConfig(home, keyFile(key));
  if (claimed === null) return null;
  if (!isRecord(claimed) || typeof claimed.workflow !== "string" || typeof claimed.run_id !== "string") throw new StateCorruptError(`${keyFile(key)} has an unexpected shape`);
  return loadRun(home, claimed.workflow, claimed.run_id);
}

/** Claims the record's key (exclusive create) and writes its run.json; false when the key was claimed before. */
export async function claimRun(home: string, record: RunRecord): Promise<boolean> {
  const path = await confinedPath(home, keyFile(record.key));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!(await createExclusive(path, JSON.stringify({ workflow: record.workflow, run_id: record.run_id })))) return false;
  await saveRun(home, record);
  return true;
}

export const saveStep = (home: string, record: RunRecord, log: StepLog): Promise<void> => writeConfig(home, stepFile(record, log.step), log);

export async function loadStep(home: string, record: RunRecord, step: string): Promise<StepLog | null> {
  const raw = await readConfig(home, stepFile(record, step));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.step !== step || !(STEP_STATUSES as readonly unknown[]).includes(raw.status)) throw new StateCorruptError(`${stepFile(record, step)} has an unexpected shape`);
  return raw as unknown as StepLog;
}

async function folderNames(home: string, relative: string): Promise<string[]> {
  try {
    return (await readdir(await confinedPath(home, relative), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Called with a damaged run record's error instead of throwing it, so one damaged file does not stop the rest. */
export type OnDamaged = (error: StateCorruptError, workflow: string, runId: string) => Promise<void>;

async function loadRunOrSkip(home: string, workflow: string, runId: string, damaged?: OnDamaged): Promise<RunRecord | null> {
  try {
    return await loadRun(home, workflow, runId);
  } catch (error) {
    if (!damaged || !(error instanceof StateCorruptError)) throw error;
    await damaged(error, workflow, runId);
    return null;
  }
}

/** Every run (of one workflow, or of all), oldest first by scheduled time or start; `damaged` skips bad records. */
export async function listRuns(home: string, workflow?: string, damaged?: OnDamaged): Promise<RunRecord[]> {
  const workflows = workflow === undefined ? await folderNames(home, RUNS_DIR) : [workflow];
  const runs: RunRecord[] = [];
  for (const name of workflows) {
    for (const runId of await folderNames(home, join(RUNS_DIR, name))) {
      const record = await loadRunOrSkip(home, name, runId, damaged);
      if (record) runs.push(record);
    }
  }
  const at = (record: RunRecord): string => record.trigger.scheduled_for ?? record.started_at;
  return runs.sort((a, b) => at(a).localeCompare(at(b)) || a.run_id.localeCompare(b.run_id));
}

/** D38: a scheduled run that cannot start within its tolerance is recorded as missed, once, and never run. */
export async function recordMissed(home: string, workflow: string, version: number, key: string, scheduledFor: string, now: string): Promise<RunRecord | null> {
  const kind = workflow === REPORT_RUNS ? "report" : "cron";
  const record: RunRecord = {
    workflow, run_id: runIdFor(key, scheduledFor), key, trigger: { kind, scheduled_for: scheduledFor }, version, status: "missed",
    started_at: now, finished_at: now, sandbox: false, pid: process.pid, actions: 0, needs_human: 0, reason: "the host or the runner was not running at the scheduled time",
  };
  if (!(await claimRun(home, record))) return null;
  await auditRun(home, now, "run.missed", record, { scheduled_for: scheduledFor });
  return record;
}
