import { readdir } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { abilities, cancelChallenge, CHECKS_DIR, FRESH_DAYS, loadChallenge, recordResult, type Need, type StoredResult } from "./checks.js";
import type { DoctorCheck, DoctorContext } from "./doctor-checks.js";
import { loadWorkflowState } from "./sandbox.js";
import type { InstallState } from "./types.js";

/**
 * Freshness (spec 8, item 7a, reviews B5–B7). A result goes stale when the agent's version changed, after 30 days, or
 * when a run contradicts it. TaskFollow's runner stops a workflow only when that workflow declares needs (a shape or
 * the person's answers, so never a workflow from before item 4) and its runner check is stale or failed after it had
 * passed; a workflow never tested runs as before. The doctor only reports; re-checking is `taskfollow check start t7`.
 */
const DAY_MS = 86_400_000;
const RECHECK = (workflow?: string): string => `Run 'taskfollow check start t7${workflow ? ` --workflow ${workflow}` : ""}' to check it again (about a minute)`;

const newestOf = (entries: readonly StoredResult[]): StoredResult | undefined => [...entries].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id).at(-1);
const stale = (entry: StoredResult, version: string | null, now: string): boolean =>
  (entry.agent_version !== null && version !== null && entry.agent_version !== version) || Date.parse(now) - Date.parse(entry.at) > FRESH_DAYS * DAY_MS;

/** Why this need's newest result no longer holds, or null: stale after a pass, a no, or a not-checked that followed a pass. */
function problem(entries: readonly StoredResult[], version: string | null, now: string): string | null {
  const newest = newestOf(entries);
  if (!newest) return null;
  if (newest.result === "no-tested") return `it failed on ${newest.at.slice(0, 10)}`;
  if (newest.result === "yes-tested") return stale(newest, version, now) ? `it was last tested on ${newest.at.slice(0, 10)}, with ${newest.agent_version === version ? "this" : "another"} version of the agent` : null;
  return entries.some((entry) => entry.result === "yes-tested") ? `a run went wrong on ${newest.at.slice(0, 10)}` : null;
}

/** The workflow's own results for a need, else the agent-wide ones (the scope fall-through of homes.ts `passed`). */
function scoped(all: readonly StoredResult[], need: Need, agent: string, workflow: string): StoredResult[] {
  const mine = all.filter((entry) => entry.need === need && entry.agent === agent && entry.workflow === workflow);
  return mine.length > 0 ? mine : all.filter((entry) => entry.need === need && entry.agent === agent && entry.workflow === undefined);
}

export async function runnerStopReason(home: string, workflow: string, state: InstallState | undefined, now: string): Promise<string | null> {
  const declared = await loadWorkflowState(home, workflow);
  if (!declared?.shape && !declared?.described) return null;
  const agent = state?.runtime?.profile;
  if (!agent) return null;
  const all = await abilities(home);
  for (const need of ["runner", "tools"] as const) {
    const why = problem(scoped(all, need, agent, workflow), state?.runtime?.agent_version ?? null, now);
    if (why) return `Not run: this workflow's check of TaskFollow's runner no longer holds (${why}). ${RECHECK(workflow)}`;
  }
  return null;
}

/** A Home 1 run whose agent did not finish its task contradicts the runner result for that workflow (review B7). */
export async function noteContradiction(home: string, workflow: string, state: InstallState | undefined, now: string): Promise<void> {
  const declared = await loadWorkflowState(home, workflow);
  if (!declared?.shape && !declared?.described) return;
  const agent = state?.runtime?.profile;
  if (!agent) return;
  await recordResult(home, { need: "runner", workflow, result: "not-checked", reason: "A run's task did not finish in TaskFollow's runner, so this goes back to not checked until it is tested again", at: now, agent, agent_version: state?.runtime?.agent_version ?? null, test: "run" });
}

/** The doctor's view (review B5): it reports stale or failed runner checks; it never runs a check itself. */
export async function checksDoctor(ctx: DoctorContext): Promise<DoctorCheck | null> {
  const agent = ctx.state?.runtime?.profile;
  if (!agent) return null;
  const all = (await abilities(ctx.home)).filter((entry) => entry.agent === agent && entry.workflow === undefined);
  if (all.length === 0) return null;
  const version = ctx.state?.runtime?.agent_version ?? null;
  const problems = (["runner", "tools"] as const).flatMap((need) => {
    const why = problem(all.filter((entry) => entry.need === need), version, ctx.now);
    return why ? [`${need}: ${why}`] : [];
  });
  if (problems.length === 0) return { id: "checks", status: "ok", detail: "the checks of what your agent can do are current" };
  return { id: "checks", status: "warn", detail: `a check of what your agent can do no longer holds (${problems.join("; ")})`, fix: RECHECK() };
}

/** Ends expired checks and removes what they made (files, test skills, check tabs); with `all`, every open check (uninstall). */
export async function sweepChecks(home: string, now: string, all = false): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, CHECKS_DIR))).filter((name) => /^c[0-9a-f]{8}\.json$/.test(name));
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    const challenge = await loadChallenge(home, name.slice(0, -5));
    if (!challenge || challenge.status !== "open" || (!all && Date.parse(now) <= Date.parse(challenge.expires_at))) continue;
    await cancelChallenge(home, challenge, all ? "TaskFollow was removed" : "it expired", now);
    if (challenge.details?.tab_id && challenge.details.spreadsheet && challenge.details.tab?.startsWith("taskfollow-check-")) {
      const { connectedSheet } = await import("./check-reads.js");
      const target = await connectedSheet(home).catch(() => null);
      if (target?.client.deleteTab && target.spreadsheet_id === challenge.details.spreadsheet) await target.client.deleteTab(challenge.details.spreadsheet, Number(challenge.details.tab_id)).catch(() => undefined);
    }
    swept += 1;
  }
  return swept;
}
