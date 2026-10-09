import { join } from "node:path";
import { AuditCorruptError, appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { DOCTOR_CHECKS, defaultFreeBytes, isDomainError, type DoctorCheck, type DoctorCheckDef, type DoctorContext } from "./doctor-checks.js";
import { systemProbe, type HostProbe } from "./host.js";
import { InputError } from "./inputs.js";
import { SolutionError } from "./solution.js";
import { StateCorruptError, loadState } from "./state.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { MAX_TEXT, invokeTool, toolContext } from "./tools.js";
import type { InstallState } from "./types.js";

/**
 * `installer doctor` (spec §16.1, D103): every check of `doctor-checks.ts`, one after the other; a check that cannot
 * finish becomes a `fail` finding, never a crash, so a damaged state or audit is reported instead of stopping it.
 * The result is kept in `state/doctor/last.json` (the report shows it) and audited. The tick runs it once a day
 * (the first tick only sets the time, like the event cursor) and tells the decision maker when something failed.
 */
export const DOCTOR_DIR = join("state", "doctor");
export const DOCTOR_FILE = join(DOCTOR_DIR, "last.json");
export const DOCTOR_NEXT = join(DOCTOR_DIR, "next.json");
export const DOCTOR_EVERY_MS = 24 * 60 * 60 * 1000;

type Env = Readonly<Record<string, string | undefined>>;

export interface DoctorReport {
  readonly status: "ok" | "warn" | "fail";
  readonly checked_at: string;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly now: () => string;
  readonly env?: Env;
  readonly freeBytes?: (path: string) => Promise<number>;
  /** The OS settings reader for host readiness; by default the real one, unless INSTALLER_HOST_CHECKS=none. */
  readonly host?: HostProbe | null;
}

async function contextOf(home: string, options: DoctorOptions): Promise<DoctorContext> {
  const env = options.env ?? process.env;
  const base = { home, now: options.now(), env, freeBytes: options.freeBytes ?? defaultFreeBytes, host: options.host === undefined ? systemProbe(env) : options.host };
  let state: InstallState | null;
  try {
    state = await loadState(home);
  } catch (error) {
    if (!(error instanceof StateCorruptError)) throw error;
    return { ...base, state: null, stateError: error.message };
  }
  if (!state) throw new InputError("No install found in this home; run 'installer start --solution <ref>' first");
  return { ...base, state };
}

async function runOne(check: DoctorCheckDef, ctx: DoctorContext): Promise<DoctorCheck[]> {
  try {
    const found = await check.run(ctx);
    return found === null ? [] : Array.isArray(found) ? [...found] : [found as DoctorCheck];
  } catch (error) {
    if (!isDomainError(error) && !(error instanceof AuditCorruptError) && !(error instanceof SolutionError)) throw error;
    return [{ id: check.id, status: "fail", detail: error.message }];
  }
}

const overall = (checks: readonly DoctorCheck[]): DoctorReport["status"] =>
  checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";

export async function runDoctor(home: string, options: DoctorOptions, checks: readonly DoctorCheckDef[] = DOCTOR_CHECKS): Promise<DoctorReport> {
  const ctx = await contextOf(home, options);
  const found: DoctorCheck[] = [];
  for (const check of checks) found.push(...(await runOne(check, ctx)));
  const report: DoctorReport = { status: overall(found), checked_at: ctx.now, checks: found };
  await writeConfig(home, DOCTOR_FILE, report);
  // A damaged audit gets no new line; the finding itself says what to do.
  if (!found.some((check) => check.id === "audit" && check.status === "fail")) {
    const counts = Object.fromEntries((["ok", "warn", "fail", "fixed"] as const).map((status) => [status, found.filter((check) => check.status === status).length]));
    await appendAudit(home, { ts: ctx.now, actor: "engine", event: "doctor.ran", ref: DOCTOR_FILE, payload: { status: report.status, ...counts } });
  }
  return report;
}

export const loadDoctorReport = async (home: string): Promise<DoctorReport | null> => (await readConfig(home, DOCTOR_FILE)) as DoctorReport | null;

/** The daily findings that failed, to the decision maker (L1, R6 and the kill switch apply); a message that cannot go out is audited. */
async function tellFailures(home: string, now: () => string, report: DoctorReport): Promise<void> {
  const failed = report.checks.filter((check) => check.status === "fail");
  const text = `Daily check: ${failed.length} problem(s). ${failed.map((check) => `${check.id}: ${check.detail}${check.fix ? ` (fix: ${check.fix})` : ""}`).join(" | ")} Run 'installer doctor' for the whole list.`.slice(0, MAX_TEXT);
  const name = (await loadState(home))?.roles?.decision_maker;
  let error: string | null = name ? null : "no decision maker is set (MODE phase)";
  if (name) {
    try {
      await invokeTool(await toolContext(home, "runner", DEFAULT_TOOLS, now), "channel.notify", { member: name, text });
    } catch (failure) {
      if (!isDomainError(failure)) throw failure;
      error = failure.message;
    }
  }
  await appendAudit(home, { ts: now(), actor: "engine", event: "doctor.notified", ref: DOCTOR_FILE, payload: { failed: failed.map((check) => check.id), delivered: error === null, ...(error ? { error } : {}) } });
}

/** Run by the tick: once every DOCTOR_EVERY_MS; the first call only sets the time. Returns the report when it ran. */
export async function dailyDoctor(home: string, now: () => string, env?: Env): Promise<DoctorReport | null> {
  const at = now();
  const next = ((await readConfig(home, DOCTOR_NEXT)) as { at?: string } | null)?.at;
  if (next !== undefined && at < next) return null;
  await writeConfig(home, DOCTOR_NEXT, { at: new Date(Date.parse(at) + DOCTOR_EVERY_MS).toISOString() });
  if (next === undefined) return null;
  const report = await runDoctor(home, { now, ...(env ? { env } : {}) });
  if (report.status === "fail") await tellFailures(home, now, report);
  return report;
}

/** `installer doctor`: runs every check now and prints the findings. */
export const doctorCommand = (home: string, now: () => string): Promise<DoctorReport> => runDoctor(home, { now });
