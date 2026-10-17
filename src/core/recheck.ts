import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { runnerCheck } from "./check-runner.js";
import { listChannels, isCustomersOnly } from "./channels.js";
import { abilities, recordResult } from "./checks.js";
import { readConfig, writeConfig } from "./data-source.js";
import { isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import { isPaused } from "./pause.js";
import { sandboxMode } from "./sandbox.js";
import { probedAgent } from "./probed-agent.js";
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
