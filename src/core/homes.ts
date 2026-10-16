import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendAudit, canonicalJson } from "./audit.js";
import { freshResult, type Need } from "./checks.js";
import { readConfig } from "./data-source.js";
import { needsApproval } from "./levels.js";
import { loadWorkflowState, saveWorkflowState } from "./sandbox.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { WORKFLOWS_DIR, WORKFLOW_FILE, type Workflow } from "./workflow.js";

/**
 * Where a workflow runs, decided by code (spec section 7, D159). Hard-rule work (any write, any send to someone other
 * than the person, payments, deletes) runs only in TaskFollow's runner, or stays draft-only; it never moves to the
 * agent's own scheduler. Whether work is hard-rule comes from a code floor over its steps, then from the shipped
 * shape's constant (honoured only while the workflow file is unchanged), or for a described workflow from the
 * person's own answers on their check page, bound to the description. Never from a file the agent writes.
 */
export const SHAPES: Readonly<Record<string, { readonly needs: readonly Need[]; readonly hardRule: boolean | "ask" }>> = {
  "inbox-triage": { needs: ["answers", "reads:email", "skills"], hardRule: false },
  "inbox-triage-replies": { needs: ["answers", "reads:email", "skills", "tools"], hardRule: true },
  "lead-qualification": { needs: ["answers", "reads:messages", "skills", "writes:records", "tools"], hardRule: true },
  "crm-update": { needs: ["answers", "reads:messages", "skills", "writes:records", "tools"], hardRule: true },
  "invoice-processing": { needs: ["answers", "reads:email", "skills", "writes:records", "tools"], hardRule: true },
  "meeting-follow-up": { needs: ["answers", "reads:files", "skills"], hardRule: "ask" },
};

export type Home = { readonly home: "runner" } | { readonly home: "agent-scheduler"; readonly agent: string } | { readonly home: "draft-only" } | { readonly home: "by-hand" };
export interface AgentRef {
  readonly agent: string;
  readonly version: string | null;
}
export interface Wish {
  readonly whileAway: boolean;
  /** The agent TaskFollow's runner drives (the install's probed agent). */
  readonly runner: AgentRef;
  /** The agent whose own scheduler would host it, when the person has one. */
  readonly homeAgent?: AgentRef;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const workflowHash = (raw: unknown): string => sha256(canonicalJson(raw));
export const descriptionHash = (description: string): string => sha256(description.trim());

const levelOf = (tool: string): "L0" | "L1" | "L2" | "L3" => {
  const def = DEFAULT_TOOLS.get(tool);
  if (!def) return "L2";
  if (def.meta) return "L0";
  if (def.categories && def.categories.length > 0) return "L3";
  return def.level ?? "L2";
};

/** The floor no answer can lower: a step or agent tool that needs approval, or a task step that may change things. */
export function codeFloor(workflow: Workflow): boolean {
  return workflow.steps.some((step) => {
    if (step.kind === "tool" || step.kind === "approve") return step.kind === "approve" || needsApproval(levelOf(step.tool));
    if (step.kind === "agent") return step.agent.tools.some((tool) => needsApproval(levelOf(tool)));
    if (step.kind === "task") return step.task.changes;
    return false;
  });
}

async function hardRule(home: string, workflow: Workflow): Promise<{ hard: boolean; why: string }> {
  if (codeFloor(workflow)) return { hard: true, why: "it has a step that sends, writes, pays or deletes" };
  const state = await loadWorkflowState(home, workflow.id);
  const raw = await readConfig(home, join(WORKFLOWS_DIR, workflow.id, WORKFLOW_FILE));
  const shape = state?.shape ? SHAPES[state.shape] : undefined;
  const unchanged = state?.content_hash !== undefined && state.content_hash === workflowHash(raw);
  if (shape && unchanged && shape.hardRule !== "ask") return { hard: shape.hardRule, why: shape.hardRule ? "this kind of workflow sends, writes or pays" : "this kind of workflow only reads and reports to you" };
  const answers = state?.described;
  if (answers && answers.description_hash === descriptionHash(workflow.description) && !answers.sends_to_others && !answers.writes_or_deletes) return { hard: false, why: "you told us it sends nothing to anyone but you and changes nothing" };
  return { hard: true, why: answers ? "it changed since you answered, or you said it sends or changes something" : "nobody has confirmed yet that it only reads and reports to you" };
}

/** Only from the person's check page: their two answers about a described workflow, bound to its description. */
export async function confirmDescribed(home: string, workflow: string, hashOfDescription: string, answers: { sendsToOthers: boolean; writesOrDeletes: boolean }, now: string): Promise<void> {
  const state = (await loadWorkflowState(home, workflow)) ?? { workflow, sandbox: true };
  await saveWorkflowState(home, { ...state, described: { description_hash: hashOfDescription, sends_to_others: answers.sendsToOthers, writes_or_deletes: answers.writesOrDeletes, at: now } });
  await appendAudit(home, { ts: now, actor: "human", event: "check.described", ref: `workflow:${workflow}`, payload: { sends_to_others: answers.sendsToOthers, writes_or_deletes: answers.writesOrDeletes } });
}

async function passed(home: string, need: Need, who: AgentRef | undefined, now: string, workflow: string, accept: readonly string[]): Promise<boolean> {
  if (!who) return false;
  for (const scope of [workflow, undefined]) {
    const result = await freshResult(home, need, who.agent, who.version, now, scope);
    if (result) return accept.includes(result.result);
  }
  return false;
}

export async function decideHome(home: string, workflow: Workflow, wish: Wish, now: string): Promise<{ home: Home; why: string; missing: readonly Need[] }> {
  const rule = await hardRule(home, workflow);
  const runnerOk = (await passed(home, "runner", wish.runner, now, workflow.id, ["yes-tested"])) && (await passed(home, "tools", wish.runner, now, workflow.id, ["yes-tested"]));
  const schedulerOk = await passed(home, "scheduler", wish.homeAgent, now, workflow.id, ["yes-tested", "yes-you-told-us"]);
  const missing: Need[] = [...(runnerOk ? [] : (["runner", "tools"] as Need[])), ...(schedulerOk || rule.hard ? [] : (["scheduler"] as Need[]))];
  if (rule.hard) {
    if (runnerOk) return { home: { home: "runner" }, why: `TaskFollow's runner, with its gate: ${rule.why}`, missing };
    return { home: { home: "draft-only" }, why: `Draft-only: ${rule.why}, and TaskFollow's runner is not tested for this agent; the agent prepares, you send`, missing };
  }
  const agentHome: Home | null = schedulerOk && wish.homeAgent ? { home: "agent-scheduler", agent: wish.homeAgent.agent } : null;
  if (wish.whileAway && agentHome) return { home: agentHome, why: `Your agent's own schedule, so it runs while you are away: ${rule.why}`, missing };
  if (runnerOk) return { home: { home: "runner" }, why: `TaskFollow's runner, which keeps a record of each run: ${rule.why}`, missing };
  if (agentHome) return { home: agentHome, why: `Your agent's own schedule: ${rule.why}`, missing };
  return { home: { home: "by-hand" }, why: "Nothing that runs on a schedule is tested yet: ask your agent and it does it now", missing };
}
