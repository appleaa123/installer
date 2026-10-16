import { agentOf, type CheckContext } from "./check-commands.js";
import { freshResult, recordResult, type Need, type ResultKind, type StoredResult } from "./checks.js";
import { decideHome, type AgentRef } from "./homes.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";

/**
 * The person's page for one workflow (spec section 6, plan Task 11, D160): each need with how TaskFollow knows, in
 * plain words with a gloss, then the home decided by code and what it means. A Home 2 line never claims what
 * TaskFollow cannot see: it is not in that path, keeps no record there, and cannot check who the brief goes to.
 */
type Raw = Record<string, unknown>;
const ICON: Readonly<Record<ResultKind, string>> = { "yes-tested": "✅", "yes-you-told-us": "✅", "not-checked": "⚠️", "no-tested": "❌" };
const WORDS: Readonly<Record<ResultKind, string>> = {
  "yes-tested": "yes, tested (we saw it)", "yes-you-told-us": "yes, you told us (you saw it)", "not-checked": "not checked (nobody has seen it yet)", "no-tested": "no, tested",
};
const LABELS: Readonly<Record<string, string>> = {
  answers: "Done once, now", "reads:email": "Reads your email", skills: "Has the workflow's skill", scheduler: "Runs on its own schedule", runner: "Runs in TaskFollow's runner", tools: "Reaches TaskFollow's tools",
};

const HOME_WORDS: Readonly<Record<string, (agent?: string) => string>> = {
  runner: () => "Home: TaskFollow's runner on this computer. Its gate asks you before anything is sent, written or deleted, and it keeps a record of each run (taskfollow why). It runs while this computer is on and awake.",
  "agent-scheduler": (agent) => `Home: your assistant's own schedule (${agent ?? "your assistant"}). TaskFollow is not in the path there: only your assistant's own rules apply, and TaskFollow keeps no record of what it did each time. This workflow is written to send only to you; on this home TaskFollow cannot check that. Each brief ends with one line; the assistant you set TaskFollow up with asks at your next session there whether it came.`,
  "draft-only": () => "Home: draft-only for now. Your assistant prepares the work and you send or act yourself. This is an instruction, not a gate.",
  "by-hand": () => "Home: by hand for now. Ask your assistant and it does the work right away.",
};

async function line(home: string, need: Need, who: AgentRef | undefined, workflow: string, now: string): Promise<string> {
  let found: StoredResult | null = null;
  if (who) found = (await freshResult(home, need, who.agent, who.version, now, workflow)) ?? (await freshResult(home, need, who.agent, who.version, now));
  const label = (LABELS[need] ?? need).padEnd(26);
  if (!found) return `  ⚠️ ${label} ${WORDS["not-checked"]}`;
  return `  ${ICON[found.result]} ${label} ${WORDS[found.result]}, ${found.at.slice(0, 10)}: ${found.reason}`;
}

export async function summaryCommand(home: string, state: InstallState | undefined, id: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const value = typeof flags.value === "string" ? flags.value : undefined;
  const runner = agentOf(state, undefined);
  const named = value && /"agent"/.test(value) ? agentOf(state, value) : undefined;
  const whileAway = value !== undefined && /"while_away"\s*:\s*true/.test(value);
  const now = context.now();
  const runnerRef = { agent: runner.agent, version: runner.version };
  const homeRef = named ? { agent: named.agent, version: named.version } : undefined;
  const decided = await decideHome(home, workflow, { whileAway, runner: runnerRef, ...(homeRef ? { homeAgent: homeRef } : {}) }, now);
  const onHome2 = decided.home.home === "agent-scheduler";
  const reader = onHome2 ? homeRef : runnerRef;
  const lines = [
    await line(home, "answers", runnerRef, workflow.id, now),
    await line(home, "reads:email", reader, workflow.id, now),
    await line(home, "skills", reader, workflow.id, now),
    ...(onHome2 || homeRef ? [await line(home, "scheduler", homeRef, workflow.id, now)] : [await line(home, "runner", runnerRef, workflow.id, now)]),
  ];
  const agentName = decided.home.home === "agent-scheduler" ? decided.home.agent : undefined;
  const homeText = (HOME_WORDS[decided.home.home] ?? (() => ""))(agentName);
  const text = [workflow.description || workflow.id, ...lines, homeText, `Why: ${decided.why}`].join("\n");
  return { workflow: workflow.id, home: decided.home.home, lines, missing: decided.missing, text };
}

/** The person said a scheduled brief did not arrive (spec section 8): the schedule's result goes back to not checked. It can only lower. */
export async function missedCommand(home: string, state: InstallState | undefined, id: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const { agent, version } = agentOf(state, typeof flags.value === "string" ? flags.value : undefined);
  const reason = "You said a scheduled brief did not arrive, so this goes back to not checked until the schedule is tested again";
  await recordResult(home, { need: "scheduler", workflow: workflow.id, result: "not-checked", reason, at: context.now(), agent, agent_version: version, test: "missed" });
  return { need: "scheduler", workflow: workflow.id, result: "not checked", why: reason };
}
