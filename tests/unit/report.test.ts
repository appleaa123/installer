import { describe, expect, it } from "vitest";
import { parseSolution } from "../../src/core/solution.js";
import { buildReport, renderReport } from "../../src/core/report.js";
import type { InstallState, StepRecord } from "../../src/core/types.js";
import { FIXTURE_REF, basicSolution } from "../helpers/memory-deps.js";

const AT = "2026-01-01T00:00:00.000Z";
const done: StepRecord = { status: "done", at: AT };
const ALL = ["preflight.write-config", "preflight.check-config", "mode.shared-work", "mode.report-time", "brain.register", "channels.optional-extra", "report.final"];

function stateWith(records: Record<string, StepRecord>): InstallState {
  return { schema: 1, solution: { ref: FIXTURE_REF, id: "fixture-basic", version: "1.0.0" }, started_at: AT, steps: records };
}

const allDone = (overrides: Record<string, StepRecord> = {}): InstallState =>
  stateWith({ ...Object.fromEntries(ALL.map((id) => [id, done])), ...overrides });

describe("buildReport", () => {
  it("is in_progress with the current question under needs_you", () => {
    const report = buildReport(basicSolution(), stateWith({ "preflight.write-config": done, "preflight.check-config": done }));
    expect(report.overall).toBe("in_progress");
    expect(report.phase).toBe("MODE");
    expect(report.needs_you.map((item) => item.step_id)).toEqual(["mode.shared-work"]);
    expect(report.done).toBe(2);
    expect(report.total).toBe(7);
  });

  it("is blocked when a blocking step is blocked, with the resume instruction", () => {
    const blocked: StepRecord = { status: "blocked", at: AT, attempts: 3, hint: "config/agent-marker.txt not found" };
    const report = buildReport(basicSolution(), stateWith({ ...Object.fromEntries(ALL.slice(0, 4).map((id) => [id, done])), "brain.register": blocked }));
    expect(report.overall).toBe("blocked");
    expect(report.needs_you).toHaveLength(1);
    expect(report.needs_you[0]?.detail).toContain("installer resume");
  });

  it("is ready_with_limits when only a non-blocking step is blocked", () => {
    const report = buildReport(basicSolution(), allDone({ "channels.optional-extra": { status: "blocked", at: AT, hint: "Extra channel not connected yet" } }));
    expect(report.overall).toBe("ready_with_limits");
    expect(report.limited).toEqual([{ step_id: "channels.optional-extra", title: "Connect an optional extra channel", detail: "Extra channel not connected yet" }]);
    expect(report.phase).toBeNull();
  });

  it("lists a failed current verify step once, with attempts and 'installer resume'", () => {
    const failed: StepRecord = { status: "failed", at: AT, attempts: 2, hint: "Marker not there yet" };
    const solution = parseSolution({
      id: "retry",
      version: "1",
      steps: [{ step_id: "v", phase: "PREFLIGHT", type: "verify", title: "Check", why: "Needed.", blocking: true, verify: { check: "file_exists", args: { path: "x" } } }],
    });
    const report = buildReport(solution, stateWith({ v: failed }));
    expect(report.needs_you).toEqual([{ step_id: "v", title: "Check", detail: "Marker not there yet (failed 2 of 3 tries) → then run 'installer resume'" }]);
  });

  it("names 'installer verify <id>' for a failed current agent_action", () => {
    const failed: StepRecord = { status: "failed", at: AT, attempts: 1, hint: "config/agent-marker.txt not found" };
    const report = buildReport(basicSolution(), stateWith({ ...Object.fromEntries(ALL.slice(0, 4).map((id) => [id, done])), "brain.register": failed }));
    expect(report.needs_you).toHaveLength(1);
    expect(report.needs_you[0]?.detail).toBe("config/agent-marker.txt not found (failed 1 of 3 tries) → then run 'installer verify brain.register'");
  });

  it("is ready when every step is done", () => {
    expect(buildReport(basicSolution(), allDone()).overall).toBe("ready");
  });
});

describe("renderReport", () => {
  it("renders the headline and sections", () => {
    const text = renderReport(buildReport(basicSolution(), allDone({ "channels.optional-extra": { status: "blocked", at: AT, hint: "Not connected" } })));
    expect(text).toContain("READY WITH LIMITS");
    expect(text).toContain("6 of 7 steps done");
    expect(text).toContain("Connect an optional extra channel — Not connected");
  });
});
