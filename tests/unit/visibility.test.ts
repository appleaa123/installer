import { describe, expect, it } from "vitest";
import { stepVisible, visibleSteps, whenHolds } from "../../src/core/visibility.js";
import type { InstallState, Solution, StepDef, StepRecord } from "../../src/core/types.js";

const AT = "2026-10-14T12:00:00.000Z";
const answered = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
const state = (steps: Record<string, StepRecord>): InstallState => ({ schema: 1, solution: { ref: "file:x", id: "s", version: "1" }, started_at: AT, steps });
const step = (step_id: string, extra: Partial<StepDef> = {}): StepDef => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input: { kind: "text" }, ...extra });

describe("whenHolds (D131)", () => {
  it("is true for a step with no condition", () => {
    expect(whenHolds(undefined, state({}))).toBe(true);
  });

  it("is false until the question it names has been answered", () => {
    expect(whenHolds({ step: "pick", equals: "a" }, state({}))).toBe(false);
    expect(whenHolds({ step: "pick", equals: "a" }, state({ pick: { status: "pending", at: AT } }))).toBe(false);
  });

  it("equals compares a single choice", () => {
    expect(whenHolds({ step: "pick", equals: "a" }, state({ pick: answered("a") }))).toBe(true);
    expect(whenHolds({ step: "pick", equals: "a" }, state({ pick: answered("b") }))).toBe(false);
  });

  it("includes looks inside a multiple choice, and only there", () => {
    expect(whenHolds({ step: "pick", includes: "email" }, state({ pick: answered(["telegram", "email"]) }))).toBe(true);
    expect(whenHolds({ step: "pick", includes: "email" }, state({ pick: answered(["telegram"]) }))).toBe(false);
    expect(whenHolds({ step: "pick", includes: "email" }, state({ pick: answered("email") }))).toBe(false);
  });
});

describe("whenHolds with any (9.12 item 3)", () => {
  const either = { any: [{ step: "who", equals: "team" }, { step: "telegram", equals: "telegram" }] };

  it("is true when one of its parts holds, and false when none does", () => {
    expect(whenHolds(either, state({ who: answered("team") }))).toBe(true);
    expect(whenHolds(either, state({ who: answered("me"), telegram: answered("telegram") }))).toBe(true);
    expect(whenHolds(either, state({ who: answered("me"), telegram: answered("none") }))).toBe(false);
  });

  it("counts a part whose question was never asked as false", () => {
    expect(whenHolds(either, state({ who: answered("me") }))).toBe(false);
    expect(whenHolds(either, state({}))).toBe(false);
  });
});

describe("visibleSteps", () => {
  const solution: Solution = { id: "s", version: "1", steps: [step("pick"), step("only-a", { when: { step: "pick", equals: "a" } }), step("always")] };

  it("shows only the steps whose condition holds, in order", () => {
    expect(visibleSteps(solution, state({})).map((entry) => entry.step_id)).toEqual(["pick", "always"]);
    expect(visibleSteps(solution, state({ pick: answered("a") })).map((entry) => entry.step_id)).toEqual(["pick", "only-a", "always"]);
    expect(visibleSteps(solution, state({ pick: answered("b") })).map((entry) => entry.step_id)).toEqual(["pick", "always"]);
  });

  it("stepVisible answers for one step", () => {
    expect(stepVisible(solution.steps[1] as StepDef, state({ pick: answered("a") }))).toBe(true);
  });
});
