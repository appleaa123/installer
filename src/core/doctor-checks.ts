import { watchHealth } from "./watch.js";
import { readFile, readdir, statfs } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { verifyAudit, withAuditLock } from "./audit.js";
import { checkChannel } from "./channel-commands.js";
import { listChannels } from "./channels.js";
import { CONNECTOR_SECRETS } from "./connectors.js";
import { SOURCES_DIR, loadSource, readConfig } from "./data-source.js";
import { gatewayStatus } from "./gateway-process.js";
import { proposeHardening } from "./hardening.js";
import { HOST_CHECKS_ENV, hostReadiness, saveReadiness, type HostProbe } from "./host.js";
import { ToolRefusal } from "./approvals.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { RUNNER_ALIVE_MS } from "./lifecycle.js";
import { MODEL_SECRET_ID, loadModelConfig } from "./model.js";
import { checkPacks, loadPacks } from "./packs.js";
import { loadPause } from "./pause.js";
import { pruneOld } from "./retention.js";
import { REPORT_RUNS, clearClaim, listRuns, orphanClaims, type RunRecord } from "./runs.js";
import { shadowPack } from "./shadow.js";
import { SKILLSWIKI_SECRET_ID, activeComboSlug, skillswikiTarget } from "./skillswiki.js";
import { StateCorruptError, isInstallState, statePath } from "./state.js";
import { HEARTBEAT_FILE } from "./tick.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The checks of `taskfollow doctor` (spec §16.1, D103). Each looks at one part of the install and says `ok`, `warn`
 * (it works, but something needs a look), `fail` (something is broken) or `fixed` (doctor repaired it itself: only
 * run claims a crash left behind, and data past the retention period). Every finding names what to do next.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "fixed";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly fix?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export interface DoctorContext {
  readonly home: string;
  readonly state: InstallState | null;
  /** Why the install state could not be read, when it could not. */
  readonly stateError?: string;
  readonly now: string;
  readonly env: Env;
  readonly freeBytes: (path: string) => Promise<number>;
  /** Reads the OS settings of host readiness (D104); null where host checks are switched off. */
  readonly host: HostProbe | null;
  /** Whether a new pack version is tried in shadow here; the daily doctor from the tick only compares the pins. */
  readonly shadow: boolean;
}

export interface DoctorCheckDef {
  readonly id: string;
  readonly run: (ctx: DoctorContext) => Promise<DoctorCheck | readonly DoctorCheck[] | null>;
}

/** A claim younger than this may still be getting its run.json (claimRun writes the key, then the run). */
export const CLAIM_GRACE_MS = 5 * 60 * 1000;
export const MIN_FREE_BYTES = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_FIX = "Run 'taskfollow schedule install' and ask the person to run the commands it prints (on a team host: 'taskfollow host service install')";

const ok = (id: string, detail: string): DoctorCheck => ({ id, status: "ok", detail });
/** A failure the person can act on, as opposed to a bug: it becomes a finding, never a crash. */
export const isDomainError = (error: unknown): error is Error =>
  error instanceof InputError || error instanceof ActionFailure || error instanceof ToolRefusal || error instanceof StateCorruptError;
const label = (record: RunRecord): string => `${record.workflow} ${record.run_id}`;

export const defaultFreeBytes = async (path: string): Promise<number> => {
  const info = await statfs(path);
  return info.bavail * info.bsize;
};

async function backupProblem(home: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(`${statePath(home)}.bak`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return isInstallState(JSON.parse(text)) ? null : "the state backup has an unexpected shape";
  } catch {
    return "the state backup is not valid JSON";
  }
}

async function stateCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  if (ctx.stateError) return { id: "state", status: "fail", detail: ctx.stateError, fix: "Keep a copy of both files, copy state/install-state.json.bak over state/install-state.json, then run 'taskfollow doctor' again" };
  const backup = await backupProblem(ctx.home);
  return backup === null ? ok("state", "the install state and its backup are readable") : { id: "state", status: "warn", detail: backup, fix: "The next change of the install writes a fresh backup" };
}

async function auditCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const result = await withAuditLock(ctx.home, () => verifyAudit(ctx.home, ctx.state?.audit_head));
  if (result.ok) return ok("audit", `${result.lines} lines, hash chain intact`);
  return { id: "audit", status: "fail", detail: `audit/audit.jsonl, line ${result.line}: ${result.reason}`, fix: "Never edit the audit; restore it from a copy, and send 'taskfollow support bundle' to the person who set this up" };
}

async function pauseCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const pause = await loadPause(ctx.home);
  if (!pause?.paused) return ok("pause", "running (not paused)");
  return { id: "pause", status: "warn", detail: `paused since ${pause.at} by ${pause.by}${pause.reason ? ` (${pause.reason})` : ""}: nothing is sent and no run starts`, fix: "A person runs 'taskfollow unpause' in their own terminal, or the decision maker sends /unpause" };
}

/** The keychain items this install uses: Skills Wiki, each channel, each connected source's sign-in, the direct model. */
async function expectedSecrets(ctx: DoctorContext): Promise<string[]> {
  let names: string[] = [];
  try {
    names = (await readdir(await confinedPath(ctx.home, SOURCES_DIR))).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sources = await Promise.all(names.map((name) => loadSource(ctx.home, name.slice(0, -".json".length))));
  return [...new Set([
    ...(ctx.state?.skillswiki ? [SKILLSWIKI_SECRET_ID] : []),
    ...(await listChannels(ctx.home)).map((config) => config.channel),
    ...sources.flatMap((source) => (source ? [CONNECTOR_SECRETS[source.connector.id] ?? source.connector.id] : [])),
    ...((await loadModelConfig(ctx.home)) ? [MODEL_SECRET_ID] : []),
  ])];
}

async function secretsCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const ids = await expectedSecrets(ctx);
  const missing: string[] = [];
  for (const id of ids) if ((await getSecret(id, ctx.env)) === null) missing.push(id);
  if (missing.length === 0) return ok("secrets", ids.length === 0 ? "this install stores no keychain items" : `keychain items present: ${ids.join(", ")}`);
  return { id: "secrets", status: "fail", detail: `missing from the keychain: ${missing.join(", ")}`, fix: missing.map((id) => `taskfollow secret ${id}`).join("; ") };
}

async function skillswikiCheck(ctx: DoctorContext): Promise<DoctorCheck | null> {
  if (!ctx.state?.skillswiki) return null;
  const slug = await activeComboSlug(await skillswikiTarget(ctx.state.skillswiki.url, ctx.env));
  if (slug) return ok("skillswiki", `reachable; combo '${slug}' is active`);
  return { id: "skillswiki", status: "warn", detail: "reachable, but no combo is active", fix: "Activate the combo in the Skills Wiki dashboard" };
}

async function channelsCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const config of await listChannels(ctx.home)) {
    try {
      checks.push(ok(`channel.${config.channel}`, await checkChannel(config, ctx.env)));
    } catch (error) {
      if (!isDomainError(error)) throw error;
      checks.push({ id: `channel.${config.channel}`, status: "fail", detail: error.message, fix: `Check the ${config.channel} secret ('taskfollow secret ${config.channel}') and the provider, then 'taskfollow channel ${config.channel}'` });
    }
  }
  return checks;
}

async function runnerCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const beat = (await readConfig(ctx.home, HEARTBEAT_FILE)) as { last?: string; alive?: string } | null;
  const alive = beat?.alive ?? beat?.last;
  if (!alive) return { id: "runner", status: "warn", detail: "the runner has never ticked: nothing scheduled runs", fix: SCHEDULE_FIX };
  const minutes = Math.round((Date.parse(ctx.now) - Date.parse(alive)) / 60_000);
  if (Date.parse(ctx.now) - Date.parse(alive) <= RUNNER_ALIVE_MS) return ok("runner", `ticking (last tick ${alive})`);
  return { id: "runner", status: "warn", detail: `no tick for ${minutes} minutes (last ${alive})`, fix: SCHEDULE_FIX };
}

async function gatewayCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const status = await gatewayStatus(ctx.home);
  if (status.status === "running") return ok("gateway", `running (pid ${String(status.pid)})`);
  const channels = (await listChannels(ctx.home)).length;
  if (status.status === "stale") return { id: "gateway", status: "fail", detail: String(status.note), fix: "taskfollow gateway start (on a team host: 'taskfollow host service install' starts it at boot)" };
  return channels === 0 ? ok("gateway", "no channel is set up, so no gateway is needed") : { id: "gateway", status: "warn", detail: "stopped: messages are not received and approvals are not announced", fix: "taskfollow gateway start" };
}

async function diskCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const free = await ctx.freeBytes(ctx.home);
  const gib = (free / 1024 ** 3).toFixed(1);
  if (free >= MIN_FREE_BYTES) return ok("disk", `${gib} GiB free`);
  return { id: "disk", status: "warn", detail: `only ${gib} GiB free on the engine's disk`, fix: "Free some space, or shorten the retention period in a person's terminal ('taskfollow retention --value <days>')" };
}

/** D103: a key claimed by a process that died before writing its run.json blocks that key for ever; doctor clears it. */
async function claimsCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const claims = await orphanClaims(ctx.home, ctx.now);
  const stale = claims.filter((claim) => claim.age_ms >= CLAIM_GRACE_MS);
  for (const claim of stale) await clearClaim(ctx.home, claim, ctx.now);
  if (stale.length > 0) return { id: "run_claims", status: "fixed", detail: `cleared ${stale.length} run claim(s) a crash left without their run: ${stale.map((claim) => claim.workflow ?? claim.file).join(", ")}` };
  return ok("run_claims", claims.length > 0 ? `${claims.length} run claim(s) being written right now` : "every run claim has its run");
}

async function runsCheck(ctx: DoctorContext): Promise<DoctorCheck[]> {
  const damaged: string[] = [];
  const runs = await listRuns(ctx.home, undefined, async (_error, workflow, runId) => void damaged.push(`runs/${workflow}/${runId}`));
  const since = new Date(Date.parse(ctx.now) - DAY_MS).toISOString();
  const recent = runs.filter((run) => (run.finished_at ?? run.started_at) > since);
  const problems = [
    ...recent.filter((run) => run.status === "failed" || run.status === "missed").map((run) => `${label(run)} ${run.status}`),
    ...recent.filter((run) => run.workflow === REPORT_RUNS && run.status === "completed" && run.reason).map((run) => `report ${run.run_id}: ${run.reason ?? ""}`),
  ];
  return [
    damaged.length === 0 ? ok("run_records", `${runs.length} run records readable`) : { id: "run_records", status: "warn", detail: `damaged, skipped by the tick: ${damaged.join(", ")}`, fix: "Restore each file from a copy, or remove that run's folder (the run is then forgotten)" },
    problems.length === 0 ? ok("recent_runs", `${recent.length} runs in the last 24 hours, none failed or missed`) : { id: "recent_runs", status: "warn", detail: `in the last 24 hours: ${problems.join("; ")}`, fix: "See 'taskfollow schedule list' and the run folders; 'taskfollow run <workflow>' runs one again" },
  ];
}

async function retentionCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const pruned = await pruneOld(ctx.home, ctx.now);
  const total = Object.values(pruned).reduce((sum, count) => sum + count, 0);
  if (total === 0) return ok("retention", "nothing older than the retention period");
  return { id: "retention", status: "fixed", detail: `deleted past the retention period: ${Object.entries(pruned).filter(([, count]) => count > 0).map(([what, count]) => `${count} ${what}`).join(", ")} (the audit is kept)` };
}

async function hardeningCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  const ready: string[] = [];
  for (const id of await workflowIds(ctx.home)) {
    try {
      if (!("reason" in (await proposeHardening(ctx.home, await loadWorkflow(ctx.home, id, DEFAULT_TOOLS))))) ready.push(id);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  return ok("hardening", ready.length === 0 ? "no hardening proposal is ready" : `hardening proposals ready: ${ready.join(", ")} ('taskfollow harden <workflow>' shows each)`);
}

/** Layer 1 (D42, D104): re-checked daily; the score goes into the report, the fixes are printed by 'taskfollow host'. */
async function hostCheck(ctx: DoctorContext): Promise<DoctorCheck> {
  if (!ctx.host) return ok("host", `host readiness not checked here (${HOST_CHECKS_ENV}=none)`);
  const readiness = await hostReadiness(ctx.home, ctx.state, ctx.host, ctx.now);
  await saveReadiness(ctx.home, readiness);
  const ids = (status: string) => readiness.checks.filter((entry) => entry.status === status).map((entry) => entry.id);
  const [open, unread] = [ids("fix"), ids("unknown")];
  const notRead = unread.length === 0 ? "" : `; not read: ${unread.join(", ")}`;
  if (!readiness.applies) return ok("host", `readiness ${readiness.score} (Personal mode: for information only)${notRead}`);
  if (open.length === 0) return ok("host", `readiness ${readiness.score}${notRead}`);
  return { id: "host", status: "warn", detail: `readiness ${readiness.score}; not right yet: ${open.join(", ")}${notRead}`, fix: "'taskfollow host' prints each fix; a person with administrator rights runs them in their own terminal" };
}

/** §14.3, D107, D108: a new version of a pinned pack is found, tried in shadow, and left for the decision maker. */
async function packsCheck(ctx: DoctorContext): Promise<DoctorCheck | null> {
  if (Object.keys(await loadPacks(ctx.home)).length === 0) return null;
  const updates = await checkPacks(ctx.home, ctx.state?.skillswiki?.url, ctx.now);
  if (ctx.shadow) for (const update of updates) await shadowPack(ctx.home, update.pack, () => ctx.now);
  const waiting = Object.entries(await loadPacks(ctx.home)).filter(([, pin]) => pin.candidate !== undefined);
  if (waiting.length === 0) return ok("packs", "every pinned pack is what Skills Wiki serves");
  const states = waiting.map(([pack, pin]) => `${pack}: a new version, shadow ${pin.candidate?.shadow ? (pin.candidate.shadow.passed ? "passed" : "did not pass") : "not run"}`);
  return { id: "packs", status: "warn", detail: states.join("; "), fix: "'taskfollow packs shadow <pack>' tries a version not run yet; the decision maker reads 'taskfollow packs list' and switches with 'taskfollow packs switch <pack> --as <name>' in their own terminal" };
}

/** D146: when the person watches their agent's direct calls, the hook is still in place and can run. */
export async function watchCheck(ctx: Pick<DoctorContext, "home" | "env">): Promise<DoctorCheck | null> {
  const health = await watchHealth(ctx.home, ctx.env);
  if (!health.on) return null;
  if (!health.problem) return ok("watch", "the agent's direct calls to watched services are recorded");
  return { id: "watch", status: "warn", detail: `Watching is on, but ${health.problem}`, fix: "The person runs 'taskfollow watch on' again in their own terminal (or 'taskfollow watch off')" };
}

export const DOCTOR_CHECKS: readonly DoctorCheckDef[] = [
  { id: "state", run: stateCheck },
  { id: "audit", run: auditCheck },
  { id: "pause", run: pauseCheck },
  { id: "secrets", run: secretsCheck },
  { id: "skillswiki", run: skillswikiCheck },
  { id: "packs", run: packsCheck },
  { id: "channels", run: channelsCheck },
  { id: "runner", run: runnerCheck },
  { id: "gateway", run: gatewayCheck },
  { id: "disk", run: diskCheck },
  { id: "host", run: hostCheck },
  { id: "run_claims", run: claimsCheck },
  { id: "runs", run: runsCheck },
  { id: "retention", run: retentionCheck },
  { id: "hardening", run: hardeningCheck },
  { id: "watch", run: watchCheck },
];
