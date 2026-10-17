import { join } from "node:path";
import { listApprovals, type ApprovalItem } from "./approvals.js";
import { appendAudit, canonicalJson } from "./audit.js";
import type { DataContract } from "./contract.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { callTool } from "./mcp.js";
import { claimOnce, createRecord, listRecords, replaceRecord } from "./numbered.js";
import { loadPinnedContract } from "./pin.js";
import { parseSkillswikiRef, skillswikiTarget } from "./skillswiki.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, type Workflow } from "./workflow.js";
import { loadWritten } from "./workflow-skill.js";

/**
 * The learning loop (spec §10.10, D19, D34, D97). A person who edits or rejects an approval item that a workflow
 * asked for after a judge with a Skills Wiki `skill` corrected that judgment: the runner writes a candidate learning
 * for the skill's pack, built by the engine from the person's side only (the decision, their reason, the values they
 * wrote, which fields they changed), never from the model's text, so injected input cannot become a learning. Values
 * of fields the contract tags `personal` or `protected_ground` are replaced, and so are email addresses and long
 * numbers anywhere. The tick sends pending learnings with Skills Wiki's `learning_record` through the engine's own
 * MCP client (after `learning_list`, so an identical one is not sent twice); a refusal such as Learning Mode being
 * off is kept with its reason and not retried; a network failure is retried on the next tick.
 */
export const LEARNINGS_DIR = join("state", "learnings");
export const LEARNED_DIR = join("state", "learnings", "from-approvals");
export const MAX_BODY = 600;
const REDACTED = "[redacted]";

export type Learning = {
  readonly id: number;
  readonly approval: number;
  readonly workflow: string;
  readonly pack: string;
  readonly skill_slug: string;
  readonly body: string;
  readonly status: "pending" | "recorded" | "refused" | "duplicate";
  readonly created_at: string;
  readonly sent_at?: string;
  readonly error?: string;
};

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isLearning = (value: unknown): value is Learning => isRecord(value) && typeof value.id === "number" && typeof value.body === "string" && typeof value.status === "string";

/** Field names the contract tags personal or protected_ground, in any entity (D34). */
export function personalFields(contract: DataContract | null): ReadonlySet<string> {
  const entities = Object.values(contract?.entities ?? {});
  return new Set(entities.flatMap((entity) => Object.entries(entity.fields).filter(([, field]) => field.tags.some((tag) => tag === "personal" || tag === "protected_ground")).map(([name]) => name)));
}

/** Email addresses and long numbers (phones, account numbers) never leave the host in a learning. */
export const redactText = (text: string): string => text.replace(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/g, "[email]").replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]");

export function redactValue(value: unknown, names: ReadonlySet<string>): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, names));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, names.has(key) ? REDACTED : redactValue(entry, names)]));
}

/** The last judge before the item's step that names a Skills Wiki skill: the judgment the person corrected. */
function judgedBy(workflow: Workflow, step: string): string | null {
  const index = workflow.steps.findIndex((entry) => entry.id === step);
  const judges = workflow.steps.slice(0, Math.max(0, index)).filter((entry) => entry.kind === "judge" && entry.judge.skill !== undefined);
  const last = judges.at(-1);
  return last?.kind === "judge" ? (last.judge.skill ?? null) : null;
}

/**
 * What the person did, in the engine's words, redacted, at most MAX_BODY characters. For a Skills Wiki learning
 * (D97) it speaks of the skill's judgment; for a rule candidate (item 8) it names the step the person corrected.
 */
export function learningBody(item: ApprovalItem, names: ReadonlySet<string>, kind: "skill" | "rule" = "skill"): string {
  const decision = item.decision;
  const what = kind === "skill" ? "that followed this skill's judgment" : `in step '${item.source.run?.step ?? ""}'`;
  const where = `In workflow '${item.source.run?.workflow ?? ""}', a person ${decision?.decision === "edited" ? "changed" : "rejected"} the ${item.action.tool} call ${what}.`;
  const reason = decision?.reason ? ` Their reason: "${redactText(decision.reason)}".` : "";
  const original = decision?.original?.args ?? {};
  const changed = Object.keys(item.action.args).filter((key) => canonicalJson(item.action.args[key]) !== canonicalJson(original[key]));
  const edits = decision?.decision === "edited" ? ` They changed ${changed.join(", ") || "nothing"} to: ${JSON.stringify(redactValue(Object.fromEntries(changed.map((key) => [key, item.action.args[key]])), names))}.` : "";
  const advice = kind === "skill" ? " Next time, judge similar input the way this correction shows." : "";
  return `${where}${reason}${edits}${advice}`.slice(0, MAX_BODY);
}

async function candidate(home: string, item: ApprovalItem, names: ReadonlySet<string>, now: string): Promise<Learning | null> {
  const run = item.source.run;
  if (!run || !(await claimOnce(home, LEARNED_DIR, item.id))) return null;
  let skill: string | null;
  try {
    skill = judgedBy(await loadWorkflow(home, run.workflow, DEFAULT_TOOLS), run.step);
  } catch (error) {
    if (error instanceof InputError) return null;
    throw error;
  }
  if (skill === null) return null;
  const { pack, skill: slug } = parseSkillswikiRef(skill);
  const learning = await createRecord<Learning>(home, LEARNINGS_DIR, (id) => ({ id, approval: item.id, workflow: run.workflow, pack, skill_slug: slug, body: learningBody(item, names), status: "pending", created_at: now }));
  await appendAudit(home, { ts: now, actor: "engine", event: "learning.candidate", ref: `learning:${learning.id}`, payload: { approval: item.id, pack } });
  return learning;
}

/** Every edit or rejection by a person of an item a workflow asked for becomes at most one candidate. */
export async function collectLearnings(home: string, now: string): Promise<Learning[]> {
  const names = personalFields(await loadPinnedContract(home));
  const decided = (await listApprovals(home, now)).filter((item) => item.source.run && (item.decision?.decision === "edited" || item.decision?.decision === "rejected"));
  const found: Learning[] = [];
  for (const item of decided) {
    const learning = await candidate(home, item, names, now);
    if (learning) found.push(learning);
  }
  return found;
}

/**
 * Item 8 (9.5): a person's edit or rejection of an item a workflow with its own skill folder asked for becomes one
 * rule candidate, kept on this computer until the agent proposes a rule for `references/my-rules.md` and either adds
 * it (`workflow rule`) or dismisses it. Its body comes from the person's side only, like a D97 learning; it is never
 * sent anywhere.
 */
export const RULES_DIR = join("state", "learnings", "rules");
export const RULES_CLAIM_DIR = join("state", "learnings", "from-approvals-rules");

export type RuleCandidate = {
  readonly id: number;
  readonly approval: number;
  readonly workflow: string;
  readonly step: string;
  readonly body: string;
  readonly status: "open" | "added" | "dismissed";
  readonly created_at: string;
  readonly closed_at?: string;
};

const isRuleCandidate = (value: unknown): value is RuleCandidate => isRecord(value) && typeof value.id === "number" && typeof value.body === "string" && typeof value.workflow === "string";

export async function collectRuleCandidates(home: string, now: string): Promise<RuleCandidate[]> {
  const owned = new Set((await loadWritten(home)).skill_folders.map((entry) => entry.workflow));
  const names = personalFields(await loadPinnedContract(home));
  const decided = (await listApprovals(home, now)).filter((item) => item.source.run && owned.has(item.source.run.workflow) && (item.decision?.decision === "edited" || item.decision?.decision === "rejected"));
  const found: RuleCandidate[] = [];
  for (const item of decided) {
    const run = item.source.run;
    if (!run || !(await claimOnce(home, RULES_CLAIM_DIR, item.id))) continue;
    const made = await createRecord<RuleCandidate>(home, RULES_DIR, (id) => ({ id, approval: item.id, workflow: run.workflow, step: run.step, body: learningBody(item, names, "rule"), status: "open", created_at: now }));
    await appendAudit(home, { ts: now, actor: "engine", event: "rules.candidate", ref: `rule:${made.id}`, payload: { approval: item.id, workflow: run.workflow } });
    found.push(made);
  }
  return found;
}

export const listRuleCandidates = (home: string): Promise<RuleCandidate[]> => listRecords(home, RULES_DIR, isRuleCandidate);

/** `taskfollow learnings [dismiss <n>]`: both kinds listed; a candidate the person said no to is dismissed. */
export async function learningsCommand(home: string, sub: string | undefined, id: string | undefined, now: string): Promise<Record<string, unknown>> {
  if (sub === undefined || sub === "list") return { learnings: await listLearnings(home), rule_candidates: await listRuleCandidates(home) };
  if (sub !== "dismiss" || !id || !/^[1-9]\d*$/.test(id)) throw new InputError("learnings takes: list, or 'learnings dismiss <n>' with the number of a rule candidate");
  const closed = await closeRuleCandidate(home, Number(id), "dismissed", now);
  await appendAudit(home, { ts: now, actor: "agent", event: "rules.dismissed", ref: `rule:${closed.id}`, payload: { workflow: closed.workflow } });
  return { status: "dismissed", learning: closed.id };
}

/** Closes an open candidate: its rule was added (`workflow rule`), or the person said no (`learnings dismiss`). */
export async function closeRuleCandidate(home: string, id: number, status: "added" | "dismissed", now: string): Promise<RuleCandidate> {
  const found = (await listRuleCandidates(home)).find((candidate) => candidate.id === id);
  if (!found) throw new InputError(`There is no rule candidate ${id} ('taskfollow learnings' lists them)`);
  if (found.status !== "open") throw new InputError(`Rule candidate ${id} is ${found.status} already`);
  const closed: RuleCandidate = { ...found, status, closed_at: now };
  await replaceRecord(home, RULES_DIR, closed);
  return closed;
}

const bodiesOf = (value: unknown): string[] => (isRecord(value) && Array.isArray(value.learnings) ? value.learnings : []).filter(isRecord).map((entry) => String(entry.body ?? ""));

async function send(home: string, learning: Learning, url: string | undefined, now: string): Promise<Learning> {
  const target = await skillswikiTarget(url);
  const listed = await callTool(target, "learning_list", { pack: learning.pack });
  if (listed.ok && bodiesOf(listed.value).includes(learning.body)) return { ...learning, status: "duplicate", sent_at: now };
  const recorded = await callTool(target, "learning_record", { pack: learning.pack, skill_slug: learning.skill_slug, body: learning.body });
  return recorded.ok ? { ...learning, status: "recorded", sent_at: now } : { ...learning, status: "refused", sent_at: now, error: recorded.error.slice(0, 300) };
}

/** The tick: sends pending learnings; Skills Wiki unreachable leaves them pending for the next tick. */
export async function submitLearnings(home: string, url: string | undefined, now: string): Promise<Learning[]> {
  const sent: Learning[] = [];
  for (const learning of (await listRecords(home, LEARNINGS_DIR, isLearning)).filter((entry) => entry.status === "pending")) {
    let next: Learning;
    try {
      next = await send(home, learning, url, now);
    } catch (error) {
      if (!(error instanceof ActionFailure)) throw error;
      await replaceRecord(home, LEARNINGS_DIR, { ...learning, error: error.message });
      continue;
    }
    await replaceRecord(home, LEARNINGS_DIR, next);
    await appendAudit(home, { ts: now, actor: "engine", event: `learning.${next.status}`, ref: `learning:${learning.id}`, payload: { pack: learning.pack, ...(next.error ? { error: next.error } : {}) } });
    sent.push(next);
  }
  return sent;
}

export const listLearnings = (home: string): Promise<Learning[]> => listRecords(home, LEARNINGS_DIR, isLearning);
