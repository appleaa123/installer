import { readFile } from "node:fs/promises";
import { confinedPath } from "./actions.js";
import { REASON_TOOL, summarize } from "./agent-hook.js";
import { listApprovals, type ApprovalItem } from "./approvals.js";
import { InputError } from "./inputs.js";
import { listRuns, listSteps, skipDamaged, type RunRecord, type StepLog } from "./runs.js";
import { callsFile } from "./task-step.js";

/**
 * `taskfollow why` (D138): the record is the reference. Without an argument it lists the runs of the last day (or
 * since a date); with a run id it explains that run step by step from what was kept: the run and step logs, the
 * record of the agent's calls in task steps (with the reason the agent gave, or "the agent gave no reason"), and the
 * approvals (why they were asked, who decided). No model is asked; the person's agent can read this and explain it.
 */
const DAY_MS = 86_400_000;
const RUN_ID = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const AGENT = "your agent";
const ENGINE = "TaskFollow";

export interface WhyEntry {
  readonly at: string;
  readonly who: string;
  readonly what: string;
  readonly why: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function triggerWhy(record: RunRecord): string {
  switch (record.trigger.kind) {
    case "cron":
      return `it was scheduled for ${record.trigger.scheduled_for ?? "this time"}`;
    case "event":
      return `a message arrived (inbox item ${record.trigger.inbox_id ?? "?"})`;
    case "report":
      return "the daily report runs it";
    case "manual":
      return record.sandbox ? "someone started a dry run" : "someone started it by hand";
  }
}

async function callLines(home: string, record: RunRecord, step: string): Promise<Raw[]> {
  try {
    const text = await readFile(await confinedPath(home, callsFile(record, step)), "utf8");
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown).filter(isRecord);
  } catch {
    return [];
  }
}

/** Each call of the agent, with the reason it stated before it (same session, same tool), or none. */
function callEntries(lines: readonly Raw[]): WhyEntry[] {
  const pending = new Map<string, string>();
  const entries: WhyEntry[] = [];
  for (const line of lines) {
    const tool = str(line.tool);
    const key = `${str(line.session)} ${str(line.reason_for) || tool}`;
    if (tool === REASON_TOOL) {
      pending.set(key, str(line.why));
      continue;
    }
    const what = `${tool} ${str(line.input)}`.trim();
    if (line.outcome === "refused") {
      entries.push({ at: str(line.ts), who: ENGINE, what: `refused ${what}`, why: str(line.refused_because) });
      continue;
    }
    entries.push({ at: str(line.ts), who: AGENT, what: line.outcome === "failed" ? `${what} (failed)` : what, why: pending.get(key) ?? "the agent gave no reason" });
    pending.delete(key);
  }
  return entries;
}

function approvalEntries(item: ApprovalItem): WhyEntry[] {
  const what = `${item.action.tool} ${summarize(item.action.args)}`;
  const asked: WhyEntry = { at: item.created_at, who: ENGINE, what: `asked a person to approve ${what}`, why: item.why };
  if (!item.decision) return [asked, { at: item.expires_at, who: ENGINE, what: `approval ${item.id} is ${item.status}`, why: "" }];
  return [asked, { at: item.decision.at, who: item.decision.by, what: `${item.decision.decision} ${item.action.tool}`, why: item.decision.reason ?? "" }];
}

function stepEntry(log: StepLog): WhyEntry | null {
  if (log.skipped) return { at: log.started_at, who: ENGINE, what: `skipped step ${log.step}`, why: "its condition did not hold, or it may change things and this was a dry run" };
  if (log.status === "failed") return { at: log.finished_at, who: ENGINE, what: `step ${log.step} failed`, why: log.error ?? "" };
  if (log.status === "rejected") return { at: log.finished_at, who: ENGINE, what: `step ${log.step} was not done`, why: "a person rejected it" };
  if (log.needs_human && log.needs_human.length > 0) return { at: log.finished_at, who: ENGINE, what: `step ${log.step} needs a person`, why: log.needs_human.map((need) => need.reason).join("; ") };
  return null;
}

async function explainRun(home: string, record: RunRecord, now: string): Promise<WhyEntry[]> {
  const approvals = (await listApprovals(home, now)).filter((item) => item.source.run?.workflow === record.workflow && item.source.run.run_id === record.run_id);
  const entries: WhyEntry[] = [{ at: record.started_at, who: ENGINE, what: `started the run (${record.trigger.kind}) of workflow '${record.workflow}'`, why: triggerWhy(record) }];
  for (const log of await listSteps(home, record)) {
    entries.push(...callEntries(await callLines(home, record, log.step)));
    for (const item of approvals.filter((candidate) => candidate.source.run?.step === log.step)) entries.push(...approvalEntries(item));
    const own = stepEntry(log);
    if (own) entries.push(own);
  }
  if (record.finished_at) entries.push({ at: record.finished_at, who: ENGINE, what: `finished the run: ${record.status}`, why: record.reason ?? "" });
  else entries.push({ at: now, who: ENGINE, what: `the run is ${record.status}`, why: record.waiting_on === undefined ? "" : `it waits for approval ${record.waiting_on}` });
  return entries;
}

export async function whyCommand(home: string, arg: string | undefined, now: () => string): Promise<Raw> {
  if (arg !== undefined && RUN_ID.test(arg)) {
    const record = (await listRuns(home, undefined, skipDamaged)).find((run) => run.run_id === arg);
    if (!record) throw new InputError(`No run '${arg}': 'taskfollow why' lists the recent runs`);
    return { run: { workflow: record.workflow, run_id: record.run_id, status: record.status, sandbox: record.sandbox }, timeline: await explainRun(home, record, now()) };
  }
  if (arg !== undefined && !DATE.test(arg)) throw new InputError("why takes a run id (for example 2026-10-14-1a2b3c4d), or a date to list the runs since (for example 2026-10-13)");
  const since = arg ?? new Date(Date.parse(now()) - DAY_MS).toISOString();
  const runs = (await listRuns(home, undefined, skipDamaged)).filter((run) => run.started_at >= since).sort((a, b) => a.started_at.localeCompare(b.started_at));
  return {
    since,
    runs: runs.map((run) => ({ run_id: run.run_id, workflow: run.workflow, started_at: run.started_at, status: run.status, ...(run.reason ? { reason: run.reason } : {}) })),
    next: "Run 'taskfollow why <run>' with a run id to see who did what in that run, and why",
  };
}

/** For a person at a terminal: one line per entry (time, who, what, why), or one line per run. */
export function renderWhy(why: Raw): string {
  if (Array.isArray(why.timeline)) {
    return (why.timeline as WhyEntry[]).map((entry) => `${entry.at.slice(0, 16).replace("T", " ")}  ${entry.who}: ${entry.what}${entry.why ? `\n    why: ${entry.why}` : ""}`).join("\n");
  }
  const runs = Array.isArray(why.runs) ? (why.runs as Raw[]) : [];
  if (runs.length === 0) return `No runs since ${str(why.since)}.`;
  return [...runs.map((run) => `${str(run.started_at).slice(0, 16).replace("T", " ")}  ${str(run.run_id)}  ${str(run.workflow)}: ${str(run.status)}${run.reason ? ` (${str(run.reason)})` : ""}`), "", str(why.next)].join("\n");
}
