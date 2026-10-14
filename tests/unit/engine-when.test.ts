import { describe, expect, it } from "vitest";
import { EngineError, advance, currentStep, resume, start, submit } from "../../src/core/engine.js";
import { buildReport } from "../../src/core/report.js";
import { parseSolution } from "../../src/core/solution.js";
import type { InstallState } from "../../src/core/types.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ask = (step_id: string, extra: object = {}) => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input: { kind: "text" }, ...extra });
const SOLUTION = parseSolution({
  id: "picker", version: "1",
  steps: [
    ask("pick", { input: { kind: "choice", options: ["a", "b"] } }),
    ask("only-a", { when: { step: "pick", equals: "a" } }),
    ask("only-b", { when: { step: "pick", equals: "b" } }),
    ask("last"),
  ],
});

async function begin() {
  const { deps } = memoryDeps(await makeTempHome(), SOLUTION);
  const started = await start(deps, null, "file:picker.json");
  return { deps, state: started.state };
}
const answer = async (deps: Awaited<ReturnType<typeof begin>>["deps"], state: InstallState, id: string, value: unknown) => (await submit(deps, state, id, { kind: "value", value })).state;

describe("steps that depend on an earlier choice (D131)", () => {
  it("asks the choice first and keeps the dependent steps out of sight until it is answered", async () => {
    const { state } = await begin();
    expect(currentStep(SOLUTION, state)?.step_id).toBe("pick");
  });

  it("shows the steps for the chosen option and skips the others", async () => {
    const { deps, state } = await begin();
    const picked = await answer(deps, state, "pick", "a");
    expect(currentStep(SOLUTION, picked)?.step_id).toBe("only-a");
    const afterA = await answer(deps, picked, "only-a", "x");
    expect(currentStep(SOLUTION, afterA)?.step_id).toBe("last");
    const finished = await answer(deps, afterA, "last", "y");
    expect((await advance(deps, finished)).result.status).toBe("complete");
  });

  it("shows the other branch for the other option", async () => {
    const { deps, state } = await begin();
    expect(currentStep(SOLUTION, await answer(deps, state, "pick", "b"))?.step_id).toBe("only-b");
  });

  it("refuses to answer a step that is not part of the chosen setup, in plain words", async () => {
    const { deps, state } = await begin();
    const picked = await answer(deps, state, "pick", "a");
    await expect(submit(deps, picked, "only-b", { kind: "value", value: "x" })).rejects.toThrow(EngineError);
    await expect(submit(deps, picked, "only-b", { kind: "value", value: "x" })).rejects.toThrow("not part of your setup");
  });

  it("resume never reopens a step that is out of sight", async () => {
    const { deps, state } = await begin();
    const picked = await answer(deps, state, "pick", "a");
    const withOldBlock: InstallState = { ...picked, steps: { ...picked.steps, "only-b": { status: "blocked", at: "t", attempts: 3, hint: "old" } } };
    const resumed = await resume(deps, withOldBlock);
    expect(resumed.state.steps["only-b"]?.status).toBe("blocked");
  });

  it("counts only the steps in view, and ignores a stale record of a step out of sight", async () => {
    const { deps, state } = await begin();
    expect(buildReport(SOLUTION, state).total).toBe(2);
    const picked = await answer(deps, state, "pick", "a");
    const stale: InstallState = { ...picked, steps: { ...picked.steps, "only-b": { status: "done", at: "t", by: "human", value: "old" } } };
    const report = buildReport(SOLUTION, stale);
    expect(report.total).toBe(3);
    expect(report.working.map((entry) => entry.step_id)).toEqual(["pick"]);
  });
});
