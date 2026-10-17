import { NO_APPROVALS_BY_EMAIL } from "./channels.js";
import { MAX_VERIFY_ATTEMPTS, RESUME_HINT, currentStep, recordOf, retryCommand } from "./engine.js";
import { addableOptions } from "./services.js";
import { visibleSteps } from "./visibility.js";
import type { CapabilityMap, InstallState, Phase, Solution, StepDef, StepRecord } from "./types.js";

export type Overall = "ready" | "ready_with_limits" | "blocked" | "in_progress";

export interface ReportItem {
  readonly step_id: string;
  readonly title: string;
  readonly detail: string;
}

export interface Report {
  readonly overall: Overall;
  readonly solution: string;
  readonly phase: Phase | null;
  readonly done: number;
  readonly total: number;
  readonly working: readonly ReportItem[];
  readonly limited: readonly ReportItem[];
  readonly needs_you: readonly ReportItem[];
  readonly runtime: CapabilityMap | null;
  readonly runtime_limits: readonly string[];
  /** True when this install has Skills Wiki connected; an install without it has nothing to check there. */
  readonly skillswiki: boolean;
  /** Services the person did not choose and can add with `taskfollow add` (D134). */
  readonly can_add: readonly string[];
  /** How the person is told (9.4's ladder): level 1 in the agent's chat, level 3 on a channel; and the next level as a gap. */
  readonly told: Told;
  /** Where scheduled runs happen (9.13 item 4); absent when the install never asked. */
  readonly runs?: string;
  /** The newest doability results for the install's agent, in plain words (D159). */
  readonly checked?: string;
  /** A consultation instead of an install (D163): whether it finished, and where its report is. */
  readonly consult?: { readonly finished: boolean; readonly report?: string };
}

export interface Told {
  readonly level: 1 | 3;
  readonly how: string;
  readonly next_level: string;
}

/** What the agent's profile says about speaking first (a dated note, not a test: 9.4 level 2). */
export interface ReportExtras {
  readonly pushNote?: string;
  readonly pushRead?: string;
  /** The newest doability result per need for the install's agent (D159); passed in so the report stays synchronous. */
  readonly checks?: readonly { readonly need: string; readonly result: string; readonly at: string }[];
  /** The consult report's path relative to the home (D163), read by the caller so the report stays synchronous. */
  readonly consultReport?: string;
}

const CHECK_WORDS: Readonly<Record<string, string>> = { "yes-tested": "yes, tested", "yes-you-told-us": "yes, you told us", "not-checked": "not checked", "no-tested": "no, tested" };

const CHANNEL_NAMES: Readonly<Record<string, string>> = { telegram: "Telegram", email: "email", slack: "Slack" };
/** WhatsApp reaches customers, not the person (INSTALL.md section 7), so it never counts as a way to tell them. */
const PERSON_CHANNELS = Object.keys(CHANNEL_NAMES);

function personChannels(rows: readonly { step: StepDef; record: StepRecord | undefined }[]): string[] {
  const found: string[] = [];
  for (const { step, record } of rows) {
    const channel = step.verify?.check === "channel_verified" ? step.verify.args?.channel : undefined;
    if (record?.status === "done" && typeof channel === "string" && PERSON_CHANNELS.includes(channel) && !found.includes(channel)) found.push(channel);
  }
  return found;
}

function toldOf(channels: readonly string[], extras: ReportExtras): Told {
  const checked = extras.pushNote
    ? `TaskFollow has not checked whether your agent can start a conversation while you are away (${extras.pushNote}; read ${extras.pushRead ?? "undated"}). Plan as if it cannot.`
    : "Whether your agent can start a conversation while you are away is not checked for this agent. Plan as if it cannot.";
  if (channels.length === 0) {
    return {
      level: 1,
      how: "In your agent's chat, the next time you talk to it: scheduled results wait in the run record ('taskfollow why').",
      next_level: `${checked} To be told at a set time while you are away, keep this computer on and add Telegram or email ('taskfollow add telegram').`,
    };
  }
  const names = channels.map((channel) => CHANNEL_NAMES[channel] ?? channel);
  const emailOnly = channels.length === 1 && channels[0] === "email";
  return {
    level: 3,
    how: emailOnly ? `Results and alerts by email. ${NO_APPROVALS_BY_EMAIL}` : `Results, alerts and approvals on ${names.join(" and ")}; approvals also in your terminal.`,
    next_level: `${checked} Messages reach you on ${names.join(" and ")} while this computer is on.`,
  };
}

const RUNS_HERE = "Scheduled runs happen on this computer while it is on and awake; a run it misses is skipped, not run late.";
const RUNS_WANTED = "You asked for runs even when this computer is closed. Until a computer that stays on is set up (INSTALL.md section 10), scheduled runs happen here only while it is on and awake; a run it misses is skipped.";

/** D175: whose plan a run uses, said only as far as TaskFollow knows the agent. */
function planOf(runtime: CapabilityMap | undefined): string {
  if (!runtime) return "";
  if (runtime.profile === "claude-code") return " They use your own Claude plan.";
  if (runtime.profile) return " They use your own plan with that agent.";
  return " Workflows that need a model's judgment use a model key of your own (taskfollow model).";
}

function runsOf(state: InstallState): string | undefined {
  const answer = state.steps["mode.always-on"];
  if (answer?.status !== "done") return undefined;
  return `${answer.value === "yes" ? RUNS_WANTED : RUNS_HERE}${planOf(state.runtime)}`;
}

const HEADLINE: Readonly<Record<Overall, string>> = {
  ready: "✅ READY",
  ready_with_limits: "⚠️ READY WITH LIMITS",
  blocked: "⛔ BLOCKED",
  in_progress: "⏳ IN PROGRESS",
};

const item = (step: StepDef, detail: string): ReportItem => ({ step_id: step.step_id, title: step.title, detail });
const unresolved = (record: StepRecord | undefined): boolean => record?.status === "blocked" || record?.status === "skipped";

function failedDetail(step: StepDef, record: StepRecord): string {
  return `${record.hint ?? "Check failed"} (failed ${record.attempts ?? 0} of ${MAX_VERIFY_ATTEMPTS} tries) → then run '${retryCommand(step)}'`;
}

/** D175: what an agent TaskFollow has no profile for can and cannot do, in plain words. */
const UNPROFILED_LIMIT = "TaskFollow cannot start this agent by itself: scheduled runs need a model key, or run by hand when you ask; approvals and records work through `taskfollow tool`";

/** Limits the probe actually found (R5). An MCP check that has not run yet is not a limit. */
export function runtimeLimits(runtime: CapabilityMap | undefined): readonly string[] {
  if (!runtime) return [];
  if (!runtime.profile) return [UNPROFILED_LIMIT];
  return [
    ...(runtime.c4_headless ? [] : ["no headless calls"]),
    ...(runtime.c4_headless && !runtime.c4_schema ? ["no structured output"] : []),
    ...(runtime.c5_resume ? [] : ["no session resume"]),
    ...(runtime.c6_mcp === false ? ["no MCP client; Skills Wiki content is inlined"] : []),
  ];
}

export function buildReport(solution: Solution, state: InstallState, extras: ReportExtras = {}): Report {
  const inView = visibleSteps(solution, state);
  const rows = inView.map((step) => ({ step, record: state.steps[step.step_id] }));
  const consulting = state.steps["mode.purpose"]?.value === "consult";
  const cleaned = consulting && state.steps["consult.cleanup"]?.status === "done";
  // After a consultation's tidy-up the tool connection is gone, so it is not listed as working (D163).
  const working = rows.filter(({ step, record }) => record?.status === "done" && !(cleaned && step.step_id === "preflight.tools")).map(({ step }) => item(step, "done"));
  const limited = rows
    .filter(({ step, record }) => !step.blocking && unresolved(record))
    .map(({ step, record }) => item(step, record?.hint ?? record?.reason ?? record?.status ?? ""));
  const hardBlocked = rows.filter(({ step, record }) => step.blocking && record?.status === "blocked");
  const current = currentStep(solution, state);
  const waitingOnHuman = current && (current.type === "ask" || current.type === "human_action") && !hardBlocked.some(({ step }) => step.step_id === current.step_id);
  const currentRecord = current ? recordOf(state, current.step_id) : undefined;
  const failedCurrent = current && currentRecord?.status === "failed" ? item(current, failedDetail(current, currentRecord)) : null;
  const needs_you = [
    ...hardBlocked.map(({ step, record }) => item(step, `${record?.hint ?? "Blocked"} → then run '${RESUME_HINT}'`)),
    ...(failedCurrent ? [failedCurrent] : waitingOnHuman ? [item(current, current.instructions?.join(" ") ?? current.why)] : []),
  ];
  const failedChecks = (extras.checks ?? []).filter((entry) => entry.result === "no-tested").map((entry) => `${entry.need}: failed its test`);
  const limits = [...runtimeLimits(state.runtime), ...failedChecks];
  const overall: Overall =
    hardBlocked.length > 0 ? "blocked" : current ? "in_progress" : limited.length > 0 || limits.length > 0 ? "ready_with_limits" : "ready";
  return {
    overall, solution: `${solution.id}@${solution.version}`, phase: current?.phase ?? null, done: working.length, total: inView.length,
    working, limited, needs_you, runtime: state.runtime ?? null, runtime_limits: limits, skillswiki: state.skillswiki !== undefined, can_add: addableOptions(solution, state),
    told: toldOf(personChannels(rows), extras), ...(runsOf(state) ? { runs: runsOf(state) } : {}),
    ...(consulting ? { consult: { finished: current === null || current === undefined, ...(extras.consultReport ? { report: extras.consultReport } : {}) } } : {}),
    ...(extras.checks && extras.checks.length > 0 ? { checked: extras.checks.map((entry) => `${entry.need}: ${CHECK_WORDS[entry.result] ?? entry.result} (${entry.at.slice(0, 10)})`).join(" · ") } : {}),
  };
}

function agentLine(report: Report): string | null {
  const runtime = report.runtime;
  if (!runtime) return null;
  if (!runtime.profile) return `🤖 Agent      your agent (no TaskFollow profile) — ${UNPROFILED_LIMIT}`;
  const name = `${runtime.profile} ${runtime.agent_version ?? ""}`.trim();
  const missing = [...report.runtime_limits, ...(runtime.c6_mcp === "not_probed" && report.skillswiki ? ["MCP not checked yet"] : [])];
  return `🤖 Agent      ${name} — level ${runtime.support_level} of 3${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`;
}

export function renderReport(report: Report): string {
  if (report.consult?.finished) return renderConsult(report);
  const lines = [`${HEADLINE[report.overall]}  (${report.done} of ${report.total} steps done) · ${report.solution}`];
  if (report.working.length > 0) lines.push(`✅ Working    ${report.working.map((entry) => entry.title).join(" · ")}`);
  const agent = agentLine(report);
  if (agent) lines.push(agent);
  lines.push(`💬 Told       ${report.told.how}`, `             ${report.told.next_level}`);
  if (report.runs) lines.push(`🕒 Runs       ${report.runs}`);
  if (report.checked) lines.push(`🔎 Checked    ${report.checked}`);
  if (report.can_add.length > 0) lines.push(`➕ Can add    ${report.can_add.map((option) => `${option.replace(/-/g, " ")} (taskfollow add ${option})`).join(" · ")}`);
  report.limited.forEach((entry, index) => lines.push(`${index === 0 ? "⚠️ Limited   " : "             "}${entry.title} — ${entry.detail}`));
  report.needs_you.forEach((entry, index) => lines.push(`${index === 0 ? "⛔ Needs you " : "             "}${index + 1}. ${entry.title} — ${entry.detail}`));
  return lines.join("\n");
}

/** A finished consultation (D163): nothing runs, so no Told or Runs lines; the report's place and the next step. */
function renderConsult(report: Report): string {
  const lines = [`✅ CONSULTATION FINISHED: nothing is set up to run  (${report.done} of ${report.total} steps done) · ${report.solution}`];
  if (report.consult?.report) lines.push(`📄 Report     ${report.consult.report} (under TaskFollow's home; read it before forwarding)`);
  if (report.checked) lines.push(`🔎 Checked    ${report.checked}`);
  lines.push("➕ Next       to have the workflows run for you: taskfollow add install");
  return lines.join("\n");
}
