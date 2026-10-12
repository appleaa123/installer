import { MAX_VERIFY_ATTEMPTS, RESUME_HINT, currentStep, recordOf, retryCommand } from "./engine.js";
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

/** Limits the probe actually found (R5). An MCP check that has not run yet is not a limit. */
export function runtimeLimits(runtime: CapabilityMap | undefined): readonly string[] {
  if (!runtime) return [];
  if (!runtime.profile) return ["no known agent profile; fallbacks apply"];
  return [
    ...(runtime.c4_headless ? [] : ["no headless calls"]),
    ...(runtime.c4_headless && !runtime.c4_schema ? ["no structured output"] : []),
    ...(runtime.c5_resume ? [] : ["no session resume"]),
    ...(runtime.c6_mcp === false ? ["no MCP client; Skills Wiki content is inlined"] : []),
  ];
}

export function buildReport(solution: Solution, state: InstallState): Report {
  const rows = solution.steps.map((step) => ({ step, record: state.steps[step.step_id] }));
  const working = rows.filter(({ record }) => record?.status === "done").map(({ step }) => item(step, "done"));
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
  const limits = runtimeLimits(state.runtime);
  const overall: Overall =
    hardBlocked.length > 0 ? "blocked" : current ? "in_progress" : limited.length > 0 || limits.length > 0 ? "ready_with_limits" : "ready";
  return {
    overall, solution: `${solution.id}@${solution.version}`, phase: current?.phase ?? null, done: working.length, total: solution.steps.length,
    working, limited, needs_you, runtime: state.runtime ?? null, runtime_limits: limits,
  };
}

function agentLine(report: Report): string | null {
  const runtime = report.runtime;
  if (!runtime) return null;
  const name = runtime.profile ? `${runtime.profile} ${runtime.agent_version ?? ""}`.trim() : "unknown agent";
  const missing = [...report.runtime_limits, ...(runtime.c6_mcp === "not_probed" ? ["MCP not checked yet"] : [])];
  return `🤖 Agent      ${name} — level ${runtime.support_level} of 3${missing.length > 0 ? ` (${missing.join(", ")})` : ""}`;
}

export function renderReport(report: Report): string {
  const lines = [`${HEADLINE[report.overall]}  (${report.done} of ${report.total} steps done) · ${report.solution}`];
  if (report.working.length > 0) lines.push(`✅ Working    ${report.working.map((entry) => entry.title).join(" · ")}`);
  const agent = agentLine(report);
  if (agent) lines.push(agent);
  report.limited.forEach((entry, index) => lines.push(`${index === 0 ? "⚠️ Limited   " : "             "}${entry.title} — ${entry.detail}`));
  report.needs_you.forEach((entry, index) => lines.push(`${index === 0 ? "⛔ Needs you " : "             "}${index + 1}. ${entry.title} — ${entry.detail}`));
  return lines.join("\n");
}
