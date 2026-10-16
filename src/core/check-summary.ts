import { agentOf, type CheckContext } from "./check-commands.js";
import { freshResult, recordResult, type Need, type ResultKind, type StoredResult } from "./checks.js";
import { gapLines, gapWords, labelFor } from "./gap-words.js";
import { decideHome, SHAPES, type AgentRef } from "./homes.js";
import { loadWorkflowState } from "./sandbox.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import type { InstallState } from "./types.js";
import { loadWorkflow, requireWorkflowId, type Workflow } from "./workflow.js";

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

const HOME_WORDS: Readonly<Record<string, (agent?: string) => string>> = {
  runner: () => "Home: TaskFollow's runner on this computer. Its gate asks you before anything is sent, written or deleted, and it keeps a record of each run (taskfollow why). It runs while this computer is on and awake.",
  "agent-scheduler": (agent) => `Home: your assistant's own schedule (${agent ?? "your assistant"}). TaskFollow is not in the path there: only your assistant's own rules apply, and TaskFollow keeps no record of what it did each time. This workflow is written to send only to you; on this home TaskFollow cannot check that. Each brief ends with one line; the assistant you set TaskFollow up with asks at your next session there whether it came.`,
  "draft-only": () => "Home: draft-only for now. Your assistant prepares the work and you send or act yourself. This is an instruction, not a gate.",
  "by-hand": () => "Home: by hand for now. Ask your assistant and it does the work right away.",
};

async function line(home: string, need: Need, who: AgentRef | undefined, workflow: string, now: string): Promise<string[]> {
  let found: StoredResult | null = null;
  // A chat skill check (T4) never stands in for the home's own run (T7 or T8) on this page (item 7a, RF6).
  const except = need === "skills" ? ["t4"] : [];
  if (who) found = (await freshResult(home, need, who.agent, who.version, now, workflow, except)) ?? (await freshResult(home, need, who.agent, who.version, now, undefined, except));
  const label = labelFor(need).padEnd(34);
  const kind: ResultKind = found?.result ?? "not-checked";
  const head = found ? `  ${ICON[kind]} ${label} ${WORDS[kind]}, ${found.at.slice(0, 10)}: ${found.reason}` : `  ⚠️ ${label} ${WORDS["not-checked"]}`;
  const gap = gapWords(need, kind);
  return gap ? [head, ...gapLines(gap)] : [head];
}

/** Sources a workflow reads, from the TaskFollow tools its steps name (a described workflow has no shape). */
const READS_BY_TOOL: Readonly<Record<string, Need>> = { "channel.inbox": "reads:email", "channel.attachment": "reads:email-attachment", "records.find": "reads:records", "records.get": "reads:records" };

function toolsOf(workflow: Workflow): string[] {
  return workflow.steps.flatMap((step) => (step.kind === "tool" || step.kind === "approve" ? [step.tool] : step.kind === "agent" ? step.agent.tools : []));
}

/** The needs this workflow's page shows: the shipped shape's constant, else what its own steps imply (spec section 4). */
async function needsOf(home: string, workflow: Workflow): Promise<Need[]> {
  const state = await loadWorkflowState(home, workflow.id);
  const shape = state?.shape ? SHAPES[state.shape] : undefined;
  if (shape) return [...shape.needs];
  const reads = [...new Set(toolsOf(workflow).flatMap((tool) => (READS_BY_TOOL[tool] ? [READS_BY_TOOL[tool]] : [])))];
  // A task step reads through the person's own tools, which TaskFollow cannot name: say so instead of staying silent (review M4).
  const described: Need[] = reads.length === 0 && workflow.steps.some((step) => step.kind === "task") ? ["reads:described"] : [];
  return ["answers", ...reads, ...described, "skills"];
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
  const homeNeeds: Need[] = onHome2 || homeRef ? ["scheduler"] : ["runner", "tools"];
  const needs = [...new Set([...(await needsOf(home, workflow)), ...homeNeeds])];
  const lines: string[] = [];
  // "Done once" is about the work itself, seen in chat or through TaskFollow's runner; the rest is about the home it runs in.
  const whoFor = (need: Need): AgentRef | undefined => (need === "scheduler" ? homeRef : need === "answers" || need === "runner" || need === "tools" ? runnerRef : reader);
  for (const need of needs) lines.push(...(await line(home, need, whoFor(need), workflow.id, now)));
  const agentName = decided.home.home === "agent-scheduler" ? decided.home.agent : undefined;
  const homeText = (HOME_WORDS[decided.home.home] ?? (() => ""))(agentName);
  const text = [workflow.description || workflow.id, ...lines, homeText, `Why: ${decided.why}`].join("\n");
  return { workflow: workflow.id, home: decided.home.home, lines, missing: decided.missing, text };
}

/** The person said a scheduled brief did not arrive (spec section 8): the schedule's result goes back to not checked. It can only lower. */
export async function missedCommand(home: string, state: InstallState | undefined, id: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  // Review M4: a missed brief belongs to the assistant whose own schedule sent it; guessing would lower the wrong one.
  if (typeof flags.value !== "string" || !/"agent"/.test(flags.value)) throw new InputError(`check missed needs the assistant whose schedule sent it: --value '{"agent":"Claude Cowork"}'`);
  const { agent, version } = agentOf(state, flags.value);
  const reason = "You said a scheduled brief did not arrive, so this goes back to not checked until the schedule is tested again";
  await recordResult(home, { need: "scheduler", workflow: workflow.id, result: "not-checked", reason, at: context.now(), agent, agent_version: version, test: "missed" });
  return { need: "scheduler", workflow: workflow.id, result: "not checked", why: reason };
}
