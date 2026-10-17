import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { runnerCheck } from "./check-runner.js";
import { listChannels, isCustomersOnly } from "./channels.js";
import { abilities, recordResult } from "./checks.js";
import { readConfig, writeConfig } from "./data-source.js";
import { createExclusive, isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import { isPaused } from "./pause.js";
import { sandboxMode } from "./sandbox.js";
import { probedAgent } from "./probed-agent.js";
import { installerCliPath } from "./register.js";
import { loadProfileById } from "./profile.js";
import { StateCorruptError, loadState } from "./state.js";
import type { InstallState } from "./types.js";

/**
 * The weekly re-check (D174, D170): once a week TaskFollow re-runs preflight T7 on the person's agent, in its own
 * process, so a "yes, TaskFollow can run your agent unattended" that quietly became a "no" is noticed. T5 needs a
 * person's chat; T7's ping through MCP under the hook proves `tools` as well as `runner`.
 */
export const RECHECK_FILE = join("config", "recheck.json");
export const RECHECK_LOCK = join("runtime", "recheck.lock");
export const RECHECK_EVERY_MS = 7 * 86_400_000;
export const RECHECK_RETRY_MS = 86_400_000;
/** The third could-not-run in a row is recorded and told like a fail: a broken agent must not stay silent. */
export const RECHECK_ERRORS_TO_RECORD = 3;
export const RECHECK_READY_MS = 10_000;
/** `none` keeps the tick from starting the re-check process (the test suite sets it, as for the gateway). */
export const RECHECK_AUTOSTART_ENV = "INSTALLER_RECHECK_AUTOSTART";
export const RECHECK_DAMAGED = "config/recheck.json is not valid JSON; remove it and the next weekly check writes it again";

export interface RecheckState {
  readonly next?: string;
  readonly last?: { readonly at: string; readonly result: "pass" | "fail" | "error"; readonly why?: string };
  readonly errors?: number;
  readonly waiting?: readonly { readonly at: string; readonly text: string }[];
}

export async function loadRecheck(home: string): Promise<RecheckState> {
  try {
    return ((await readConfig(home, RECHECK_FILE)) as RecheckState | null) ?? {};
  } catch (error) {
    if (error instanceof StateCorruptError) throw new ActionFailure(RECHECK_DAMAGED);
    throw error;
  }
}

/**
 * The weekly check's notices that waited for the person (no channel, sandbox, paused or a channel failure), once:
 * removed as they are shown, and the showing audited. A damaged file throws StateCorruptError for `why` to report.
 */
export async function takeRecheckNotices(home: string, now: string): Promise<readonly { readonly at: string; readonly text: string }[]> {
  const recheck = ((await readConfig(home, RECHECK_FILE)) as RecheckState | null) ?? {};
  const waiting = Array.isArray(recheck.waiting) ? recheck.waiting : [];
  if (waiting.length === 0) return [];
  await writeConfig(home, RECHECK_FILE, { ...recheck, waiting: [] });
  await appendAudit(home, { ts: now, actor: "engine", event: "check.recheck_shown", ref: "recheck", payload: { count: waiting.length } });
  return waiting;
}

const consulting = (state: InstallState): boolean => state.steps["mode.purpose"]?.value === "consult";

/** The newest agent-wide pass of `runner` or `tools` for the probed agent, if its profile can run tasks at all. */
async function newestPass(home: string, state: InstallState | null): Promise<string | null> {
  if (!state || consulting(state) || !state.runtime?.profile) return null;
  const profile = await loadProfileById(state.runtime.profile).catch(() => null);
  if (!profile?.task) return null;
  const agent = probedAgent(state)?.agent;
  const passes = (await abilities(home)).filter((entry) => entry.agent === agent && entry.workflow === undefined && (entry.need === "runner" || entry.need === "tools") && entry.result === "yes-tested");
  return passes.map((entry) => entry.at).sort().at(-1) ?? null;
}

/** Whether the weekly re-check applies to this install at all (the report says so once): conditions 1–3 of the plan. */
export const recheckApplies = async (home: string, state: InstallState): Promise<boolean> => (await newestPass(home, state)) !== null;

export async function lockHolder(home: string): Promise<number | null> {
  const pid = Number(await readFile(await confinedPath(home, RECHECK_LOCK), "utf8").catch(() => "0"));
  return Number.isInteger(pid) && pid > 0 && isAlive(pid) ? pid : null;
}

/** Whether the tick should start the weekly re-check now; the first time it only sets the date (a week after the newest pass). */
export async function recheckDue(home: string, now: string): Promise<boolean> {
  const passed = await newestPass(home, await loadState(home));
  if (passed === null) return false;
  const recheck = await loadRecheck(home);
  if (recheck.next === undefined) {
    const after = new Date(Date.parse(passed) + RECHECK_EVERY_MS).toISOString();
    await writeConfig(home, RECHECK_FILE, { ...recheck, next: after > now ? after : now });
    return false;
  }
  if (now < recheck.next) return false;
  return (await lockHolder(home)) === null;
}

const NOTICE = (why: string): string =>
  `TaskFollow's weekly check found that it can no longer run your agent on this computer by itself: ${why}. Workflows that run here may stop until this is fixed. Run 'taskfollow check start t7' to check again (about a minute).`;

/** Merges into what is on disk now (D164's read-again-before-write), so a notice written meanwhile is kept. */
async function saveRecheck(home: string, patch: Omit<RecheckState, "waiting">, notice?: { readonly at: string; readonly text: string }): Promise<void> {
  const latest = await loadRecheck(home);
  await writeConfig(home, RECHECK_FILE, { ...latest, ...patch, waiting: [...(latest.waiting ?? []), ...(notice ? [notice] : [])] });
}

/**
 * The decision maker's channel when one reaches them and the engine sends (not sandbox, not paused); otherwise the
 * notice waits for `why`. A channel failure also waits: this process has no tick to surface it to (D174, unlike D164).
 */
async function tell(home: string, now: () => string, text: string): Promise<{ readonly at: string; readonly text: string } | undefined> {
  const name = (await loadState(home))?.roles?.decision_maker;
  const reaches = (await listChannels(home)).some((config) => !isCustomersOnly(config.channel));
  if (name && reaches && !(await sandboxMode(home)) && !(await isPaused(home))) {
    try {
      // Lazy: the tool set reaches this module through check-fresh.
      const { invokeTool, toolContext } = await import("./tools.js");
      const { DEFAULT_TOOLS } = await import("./tool-set.js");
      await invokeTool(await toolContext(home, "runner", DEFAULT_TOOLS, now), "channel.notify", { member: name, text });
      return undefined;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return { at: now(), text };
}

const plus = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

/** One weekly re-check: preflight T7, quiet on a task that could not run; what it found is kept and, on a no, told. */
export async function weeklyRecheck(home: string, now: () => string, env?: NodeJS.ProcessEnv, check: typeof runnerCheck = runnerCheck): Promise<"pass" | "fail" | "error"> {
  const state = (await loadState(home)) ?? undefined;
  const audit = (result: string) => appendAudit(home, { ts: now(), actor: "engine", event: "check.recheck", ref: "recheck", payload: { result } });
  let out: Record<string, unknown>;
  try {
    out = await check(home, state, { now, ...(env ? { env } : {}), quietOnError: true });
  } catch (error) {
    // TaskFollow's own failure, not the agent's: kept and tried again tomorrow, never counted toward a broken agent.
    const at = now();
    await saveRecheck(home, { next: plus(at, RECHECK_RETRY_MS), last: { at, result: "error", why: error instanceof Error ? error.message : String(error) } });
    await audit("error");
    throw error;
  }
  const at = now();
  if (out.passed === true) {
    await saveRecheck(home, { next: plus(at, RECHECK_EVERY_MS), last: { at, result: "pass" }, errors: 0 });
    await audit("pass");
    return "pass";
  }
  if (typeof out.error === "string") {
    const errors = ((await loadRecheck(home)).errors ?? 0) + 1;
    const third = errors === RECHECK_ERRORS_TO_RECORD;
    if (third) {
      const agent = probedAgent(state);
      const reason = `The weekly check could not run three times in a row: ${out.error}`;
      for (const need of ["runner", "tools"] as const) await recordResult(home, { need, result: "not-checked", reason, at, agent: agent?.agent ?? "unknown", agent_version: agent?.version ?? null, test: "t7" });
    }
    const notice = third ? await tell(home, now, NOTICE(`it could not run three times in a row (${out.error})`)) : undefined;
    await saveRecheck(home, { next: plus(at, RECHECK_RETRY_MS), last: { at, result: "error", why: out.error }, errors }, notice);
    await audit("error");
    return "error";
  }
  const why = typeof out.why === "string" ? out.why : "the check did not pass";
  const notice = await tell(home, now, NOTICE(why));
  await saveRecheck(home, { next: plus(at, RECHECK_EVERY_MS), last: { at, result: "fail", why }, errors: 0 }, notice);
  await audit("fail");
  return "fail";
}

/** What `startRecheck` needs of a child process; tests pass a fake that never runs anything. */
export interface RecheckChild {
  readonly pid?: number;
  once(event: "message", listener: (message: unknown) => void): unknown;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  disconnect(): void;
  unref(): void;
}
type SpawnChild = (home: string) => RecheckChild;
const spawnRecheck: SpawnChild = (home) =>
  spawn(process.execPath, [installerCliPath(), "--home", home, "recheck-run"], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });

/**
 * Starts `recheck-run` detached and waits, at most RECHECK_READY_MS, until it took the lock and said it is ready, as the
 * gateway starts (gateway-process.ts). A child that could not start is TaskFollow's failure, not the agent's: kept,
 * tried again tomorrow, never counted toward the third could-not-run.
 */
export async function startRecheck(home: string, now: () => string, spawnChild: SpawnChild = spawnRecheck): Promise<void> {
  const failed = async (why: string): Promise<never> => {
    const at = now();
    await saveRecheck(home, { next: plus(at, RECHECK_RETRY_MS), last: { at, result: "error", why } });
    throw new ActionFailure(why);
  };
  let child: RecheckChild;
  try {
    child = spawnChild(home);
  } catch (error) {
    return failed(`The weekly check could not start (${(error as Error).message})`);
  }
  const outcome = await new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(`The weekly check did not start within ${RECHECK_READY_MS / 1000} s`), RECHECK_READY_MS);
    child.once("message", () => {
      clearTimeout(timer);
      done(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      done(`The weekly check could not start (exit ${code})`);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      done(`The weekly check could not start (${error.message})`);
    });
  });
  if (outcome !== null) return failed(outcome);
  child.disconnect();
  child.unref();
}

/** The tick's part (D174): start the re-check when it is due, never while the suite runs (the environment switch). */
export async function startRecheckIfDue(home: string, now: () => string, env: Readonly<Record<string, string | undefined>>, start: (home: string, now: () => string) => Promise<void> = startRecheck): Promise<"started" | null> {
  if (env[RECHECK_AUTOSTART_ENV] === "none") return null;
  if (!(await recheckDue(home, now()))) return null;
  await start(home, now);
  return "started";
}

interface RunOptions {
  readonly send?: (message: unknown) => void;
  readonly check?: typeof runnerCheck;
  readonly now?: () => string;
}

/** Takes the lock, or none when a live re-check holds it (a dead holder's lock is taken over). */
async function takeLock(home: string): Promise<string | null> {
  const path = await confinedPath(home, RECHECK_LOCK);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await createExclusive(path, String(process.pid))) return path;
    if ((await lockHolder(home)) !== null) return null;
    await rm(path, { force: true });
  }
  return null;
}

/** `taskfollow recheck-run`, the detached child: lock first, then ready, then one re-check; the lock goes either way. */
export async function recheckRun(home: string, options: RunOptions = {}): Promise<number> {
  const lock = await takeLock(home);
  if (lock === null) return 3;
  try {
    (options.send ?? ((message: unknown) => process.send?.(message)))({ ready: true });
    await weeklyRecheck(home, options.now ?? (() => new Date().toISOString()), process.env, options.check);
    return 0;
  } catch {
    return 1;
  } finally {
    await rm(lock, { force: true });
  }
}
