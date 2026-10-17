import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { abilities } from "./checks.js";
import { readConfig, writeConfig } from "./data-source.js";
import { isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
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
