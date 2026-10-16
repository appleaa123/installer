import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { REASON_TOOL, summarize } from "./agent-hook.js";
import { CALLS_DIR, REASON_NAME } from "./watch-record.js";
import { listApprovals, type ApprovalItem } from "./approvals.js";
import { isCustomersOnly, listChannels } from "./channels.js";
import { InputError } from "./inputs.js";
import { StateCorruptError } from "./state.js";
import { listRuns, listSteps, skipDamaged, type RunRecord, type StepLog } from "./runs.js";
import { callsFile } from "./task-step.js";
import { takeSuggestions } from "./watch-notice.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow } from "./workflow.js";
import { DATE, DAY, RUN_ID } from "./why-patterns.js";

/**
 * `taskfollow why` (D138): the record is the reference. Without an argument it lists the runs of the last day (or
 * since a date); with a run id it explains that run step by step from what was kept: the run and step logs, the
 * record of the agent's calls in task steps (with the reason the agent gave, or "the agent gave no reason"), and the
 * approvals (why they were asked, who decided). No model is asked; the person's agent can read this and explain it.
 */
const DAY_MS = 86_400_000;
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
    // Task 28: an approved call comes after its approval, so a step's calls and approvals are told in time order.
    const asked = approvals.filter((candidate) => candidate.source.run?.step === log.step).flatMap(approvalEntries);
    entries.push(...[...callEntries(await callLines(home, record, log.step)), ...asked].sort((a, b) => a.at.localeCompare(b.at)));
    const own = stepEntry(log);
    if (own) entries.push(own);
  }
  if (record.finished_at) entries.push({ at: record.finished_at, who: ENGINE, what: `finished the run: ${record.status}`, why: record.reason ?? "" });
  else entries.push({ at: now, who: ENGINE, what: `the run is ${record.status}`, why: record.waiting_on === undefined ? "" : `it waits for approval ${record.waiting_on}` });
  return entries;
}

const DIRECT = "your agent, directly (outside TaskFollow)";

/** D146: the calls the agent made directly to watched services on one day, each with the reason it gave, if any. */
async function directCalls(home: string, day: string): Promise<WhyEntry[]> {
  let text: string;
  try {
    text = await readFile(await confinedPath(home, join(CALLS_DIR, `${day}.jsonl`)), "utf8");
  } catch {
    return [];
  }
  const pending = new Map<string, string>();
  const entries: WhyEntry[] = [];
  for (const line of text.split("\n").filter((row) => row !== "")) {
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const tool = str(row.tool);
    if (tool === REASON_NAME) {
      pending.set(`${str(row.session)} ${str(row.reason_for)}`, str(row.why));
      continue;
    }
    const key = `${str(row.session)} ${tool}`;
    entries.push({ at: str(row.ts), who: DIRECT, what: str(row.what) ? `${tool} (${str(row.what)})` : tool, why: pending.get(key) ?? "the agent gave no reason" });
    pending.delete(key);
  }
  return entries;
}

export async function whyCommand(home: string, arg: string | undefined, now: () => string, extra?: string): Promise<Raw> {
  if (arg === "direct") {
    const day = extra ?? now().slice(0, 10);
    if (!DAY.test(day)) throw new InputError("why direct takes a day, for example: taskfollow why direct 2026-10-14");
    return { day, timeline: await directCalls(home, day), note: "Only calls to the services the person chose to watch ('taskfollow watch list') are here, with the tool and the names of what it was given, never the values." };
  }
  if (arg !== undefined && RUN_ID.test(arg)) {
    const record = (await listRuns(home, undefined, skipDamaged)).find((run) => run.run_id === arg);
    if (!record) throw new InputError(`No run '${arg}': 'taskfollow why' lists the recent runs`);
    const result = await resultOf(home, record, "run");
    return { run: { workflow: record.workflow, run_id: record.run_id, status: record.status, sandbox: record.sandbox }, timeline: await explainRun(home, record, now()), ...(result ? { result } : {}) };
  }
  if (arg !== undefined && !DATE.test(arg)) throw new InputError("why takes a run id (for example 2026-10-14-1a2b3c4d), or a date to list the runs since (for example 2026-10-13)");
  const since = arg ?? new Date(Date.parse(now()) - DAY_MS).toISOString();
  const runs = (await listRuns(home, undefined, skipDamaged)).filter((run) => run.started_at >= since).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const rows = [];
  for (const run of runs) {
    const result = await resultOf(home, run);
    rows.push({ run_id: run.run_id, workflow: run.workflow, started_at: run.started_at, status: run.status, ...(run.reason ? { reason: run.reason } : {}), ...(result ? { result } : {}) });
  }
  return {
    since,
    runs: rows,
    // 9.12 item 3: with no channel, a run's result waits here; nobody was told about a run that failed or was missed.
    // WhatsApp reaches customers, not the person (as in the report), so it does not count as telling them.
    no_channel: (await listChannels(home)).every((config) => isCustomersOnly(config.channel)),
    // D164: "I noticed" suggestions no channel could deliver, shown once, at the person's next session.
    ...(await suggestionsField(home, now())),
    next: "Run 'taskfollow why <run>' with a run id to see who did what in that run, and why",
  };
}

export const DAMAGED_NOTICE = "config/watch-notice.json is not valid JSON; remove it and the next tick writes it again";

async function suggestionsField(home: string, now: string): Promise<{ suggestions?: readonly { at: string; text: string }[]; suggestions_damaged?: string }> {
  try {
    const suggestions = await takeSuggestions(home, now);
    return suggestions.length === 0 ? {} : { suggestions };
  } catch (error) {
    // An optional feature's damaged file must not stop the session-start list (INSTALL.md rule 11).
    if (!(error instanceof StateCorruptError)) throw error;
    return { suggestions_damaged: DAMAGED_NOTICE };
  }
}

/** The result of one run by id (the work done once, plan Task 7): an agent's summary whole (item 5), or undefined. */
export async function runResult(home: string, runId: string): Promise<string | undefined> {
  const record = (await listRuns(home, undefined, skipDamaged)).find((run) => run.run_id === runId);
  return record ? resultOf(home, record, "once") : undefined;
}

/**
 * A run's result, for level 1 (9.4): an agent's summary, or the last done step's output. In the list it is cut at 300
 * characters and names the run to see it whole (item 5); for one run (`why <run id>`, `check once`) an agent's summary
 * is whole and any other output stays cut, so a list that was never made never prints every message it read.
 */
async function resultOf(home: string, run: RunRecord, form: "list" | "run" | "once" = "list"): Promise<string | undefined> {
  let steps: StepLog[];
  try {
    steps = await listSteps(home, run);
  } catch (error) {
    if (!(error instanceof StateCorruptError)) throw error;
    return undefined;
  }
  const last = steps.filter((step) => step.status === "done" && !step.skipped && step.output !== null && step.output !== undefined).sort((a, b) => a.finished_at.localeCompare(b.finished_at)).at(-1);
  if (!last) return undefined;
  const output = last.output as unknown;
  const summary = typeof output === "object" && output !== null && "summary" in output && typeof (output as { summary: unknown }).summary === "string" ? (output as { summary: string }).summary : undefined;
  if (form !== "list" && summary !== undefined) return summary;
  const text = summary ?? JSON.stringify(output);
  const cut = text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT - 1)}…` : text;
  if (form === "run") return (await makesList(home, run.workflow)) ? `${cut} (this run made no list)` : cut;
  return form === "once" || cut === text ? cut : `${cut} (the whole result: taskfollow why ${run.run_id})`;
}

/** Whether the workflow has an agent step, the one that makes a list; false when its file cannot be read. */
async function makesList(home: string, workflow: string): Promise<boolean> {
  try {
    return (await loadWorkflow(home, workflow, DEFAULT_TOOLS)).steps.some((step) => step.kind === "agent");
  } catch (error) {
    if (error instanceof InputError) return false;
    throw error;
  }
}

const RESULT_LIMIT = 300;
const UNTOLD = new Set(["failed", "partial", "missed"]);

/** For a person at a terminal: one line per entry (time, who, what, why), or one line per run. */
export function renderWhy(why: Raw): string {
  if (Array.isArray(why.timeline)) {
    const lines = (why.timeline as WhyEntry[]).map((entry) => `${entry.at.slice(0, 16).replace("T", " ")}  ${entry.who}: ${entry.what}${entry.why ? `\n    why: ${entry.why}` : ""}`);
    return [...lines, ...(typeof why.result === "string" ? ["", `result:\n${why.result}`] : [])].join("\n");
  }
  const runs = Array.isArray(why.runs) ? (why.runs as Raw[]) : [];
  const suggestions = Array.isArray(why.suggestions) ? (why.suggestions as Raw[]) : [];
  const told = [
    ...(suggestions.length === 0 ? [] : ["", "TaskFollow noticed (tell the person):", ...suggestions.map((entry) => `    ${str(entry.text)}`)]),
    ...(typeof why.suggestions_damaged === "string" ? ["", why.suggestions_damaged] : []),
  ];
  if (runs.length === 0) return [`No runs since ${str(why.since)}.`, ...told].join("\n");
  const untold = why.no_channel === true;
  const lines = runs.map((run) => {
    const head = `${str(run.started_at).slice(0, 16).replace("T", " ")}  ${str(run.run_id)}  ${str(run.workflow)}: ${str(run.status)}${run.reason ? ` (${str(run.reason)})` : ""}${untold && UNTOLD.has(str(run.status)) ? " (nobody was told: no channel)" : ""}`;
    return run.result ? `${head}\n    result: ${str(run.result)}` : head;
  });
  return [...lines, ...told, "", str(why.next)].join("\n");
}
