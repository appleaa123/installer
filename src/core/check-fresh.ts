import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readConfig, writeConfig } from "./data-source.js";
import { confinedPath } from "./actions.js";
import { abilities, cancelChallenge, CHECKS_DIR, FRESH_DAYS, loadChallenge, recordResult, type Need, type StoredResult } from "./checks.js";
import type { DoctorCheck, DoctorContext } from "./doctor-checks.js";
import { loadWorkflowState } from "./sandbox.js";
import { probedAgent } from "./probed-agent.js";
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

/**
 * Why this need's newest result no longer holds, or null: stale after a pass, a no, or a not-checked that followed a
 * pass. `passedBefore` covers both scopes, so a run that contradicts an agent-wide pass still stops the workflow.
 */
function problem(entries: readonly StoredResult[], version: string | null, now: string, passedBefore = entries.some((entry) => entry.result === "yes-tested")): string | null {
  const newest = newestOf(entries);
  if (!newest) return null;
  if (newest.result === "no-tested") return `it failed on ${newest.at.slice(0, 10)}`;
  if (newest.result === "yes-tested") return stale(newest, version, now) ? `it was last tested on ${newest.at.slice(0, 10)}, with ${newest.agent_version === version ? "this" : "another"} version of the agent` : null;
  return passedBefore ? `a run went wrong on ${newest.at.slice(0, 10)}` : null;
}

/** The workflow's own results for a need, else the agent-wide ones (the scope fall-through of homes.ts `passed`), and whether either scope ever passed. */
function scoped(all: readonly StoredResult[], need: Need, agent: string, workflow: string): { entries: StoredResult[]; passedBefore: boolean } {
  const mine = all.filter((entry) => entry.need === need && entry.agent === agent && entry.workflow === workflow);
  const wide = all.filter((entry) => entry.need === need && entry.agent === agent && entry.workflow === undefined);
  return { entries: mine.length > 0 ? mine : wide, passedBefore: [...mine, ...wide].some((entry) => entry.result === "yes-tested") };
}

export async function runnerStopReason(home: string, workflow: string, state: InstallState | undefined, now: string): Promise<string | null> {
  const declared = await loadWorkflowState(home, workflow);
  if (!declared?.shape && !declared?.described) return null;
  const agent = probedAgent(state)?.agent;
  if (!agent) return null;
  const all = await abilities(home);
  for (const need of ["runner", "tools"] as const) {
    const { entries, passedBefore } = scoped(all, need, agent, workflow);
    const why = problem(entries, state?.runtime?.agent_version ?? null, now, passedBefore);
    if (why) return `Not run: this workflow's check of TaskFollow's runner no longer holds (${why}). ${RECHECK(workflow)}`;
  }
  return null;
}

/** A Home 1 run whose agent did not finish its task contradicts the runner result for that workflow (review B7). */
export async function noteContradiction(home: string, workflow: string, state: InstallState | undefined, now: string): Promise<void> {
  const declared = await loadWorkflowState(home, workflow);
  if (!declared?.shape && !declared?.described) return;
  const agent = probedAgent(state)?.agent;
  if (!agent) return;
  await recordResult(home, { need: "runner", workflow, result: "not-checked", reason: "A run's task did not finish in TaskFollow's runner, so this goes back to not checked until it is tested again", at: now, agent, agent_version: state?.runtime?.agent_version ?? null, test: "run" });
}

/**
 * A real run that finished in TaskFollow's runner proves the runner again for that workflow, and TaskFollow's own tools
 * when the agent reached them in that run (review 4 of PR #54): so a result goes stale only when the workflow has not
 * run well for 30 days. Sandbox runs and workflows without declared needs refresh nothing.
 */
export async function noteRunPassed(home: string, workflow: string, state: InstallState | undefined, now: string, toolsReached: boolean): Promise<void> {
  const declared = await loadWorkflowState(home, workflow);
  if (!declared?.shape && !declared?.described) return;
  const agent = probedAgent(state)?.agent;
  if (!agent) return;
  const base = { workflow, result: "yes-tested" as const, reason: `a real run through TaskFollow's runner finished on ${now.slice(0, 10)}`, at: now, agent, agent_version: state?.runtime?.agent_version ?? null, test: "run" };
  await recordResult(home, { need: "runner", ...base });
  if (toolsReached) await recordResult(home, { need: "tools", ...base });
}

const STOP_NOTICES = join("state", "stop-notices.json");

/** Whether today's stop notice for this workflow is still to be sent (review 4): the decision maker hears it once a day, not on every tick. */
export async function firstStopNoticeToday(home: string, workflow: string, now: string): Promise<boolean> {
  const seen = ((await readConfig(home, STOP_NOTICES)) ?? {}) as Record<string, string>;
  const day = now.slice(0, 10);
  if (seen[workflow] === day) return false;
  await writeConfig(home, STOP_NOTICES, { ...seen, [workflow]: day });
  return true;
}

/** The doctor's view (review B5): it reports stale or failed runner checks; it never runs a check itself. */
export async function checksDoctor(ctx: DoctorContext): Promise<DoctorCheck | null> {
  const agent = probedAgent(ctx.state ?? undefined)?.agent;
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

/**
 * Ends expired checks and removes what they made (files, test skills, check tabs); with `all`, every open check
 * (uninstall). It also removes a tab a closed check still carries (a cleanup that failed earlier, review 3 of PR #54).
 */
export async function sweepChecks(home: string, now: string, all = false, sheets?: Parameters<typeof import("./check-reads.js").cleanupTab>[2]): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, CHECKS_DIR))).filter((name) => /^c[0-9a-f]{8}\.json$/.test(name));
  } catch {
    return 0;
  }
  const { cleanupTab } = await import("./check-reads.js");
  let swept = 0;
  for (const name of names) {
    const id = name.slice(0, -5);
    const challenge = await loadChallenge(home, id);
    if (!challenge) continue;
    if (challenge.status === "open") {
      if (!all && Date.parse(now) <= Date.parse(challenge.expires_at)) continue;
      await cancelChallenge(home, challenge, all ? "TaskFollow was removed" : "it expired", now);
      swept += 1;
    }
    await cleanupTab(home, id, sheets);
  }
  return swept;
}
