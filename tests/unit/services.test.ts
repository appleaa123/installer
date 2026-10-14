import { describe, expect, it } from "vitest";
import { start, submit } from "../../src/core/engine.js";
import { buildReport, renderReport } from "../../src/core/report.js";
import { addService, addableOptions } from "../../src/core/services.js";
import { InputError } from "../../src/core/inputs.js";
import { parseSolution } from "../../src/core/solution.js";
import type { InstallState, Solution } from "../../src/core/types.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ask = (step_id: string, extra: object = {}) => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input: { kind: "text" }, ...extra });
const SOLUTION = parseSolution({
  id: "s", version: "1",
  steps: [
    ask("services.chat", { input: { kind: "choice", options: ["email", "none"] }, default: "none" }),
    ask("services.records", { input: { kind: "choice", options: ["google-sheets", "none"] } }),
    ask("email-step", { when: { step: "services.chat", equals: "email" } }),
    ask("sheet-step", { when: { step: "services.records", equals: "google-sheets" } }),
    ask("last"),
  ],
});
const MANY = parseSolution({
  id: "m", version: "1",
  steps: [ask("services.apps", { input: { kind: "multi_choice", options: ["telegram", "email", "slack"] } }), ask("email-step", { when: { step: "services.apps", includes: "email" } }), ask("last")],
});

async function answered(solution: Solution, answers: [string, unknown][]) {
  const { deps, events } = memoryDeps(await makeTempHome(), solution);
  let state: InstallState = (await start(deps, null, "file:s.json")).state;
  for (const [id, value] of answers) state = (await submit(deps, state, id, { kind: "value", value })).state;
  return { deps, state, events };
}
const finish = async (solution: Solution, answers: [string, unknown][]) => answered(solution, answers);

describe("what can be added later (D134)", () => {
  it("lists the services that were not chosen, never 'none'", async () => {
    const { state } = await answered(SOLUTION, [["services.chat", "none"], ["services.records", "google-sheets"]]);
    expect(addableOptions(SOLUTION, state)).toEqual(["email"]);
  });

  it("lists nothing once everything is chosen", async () => {
    const { state } = await answered(SOLUTION, [["services.chat", "email"], ["services.records", "google-sheets"]]);
    expect(addableOptions(SOLUTION, state)).toEqual([]);
  });

  it("looks inside a multiple choice too", async () => {
    const { state } = await answered(MANY, [["services.apps", ["telegram"]]]);
    expect(addableOptions(MANY, state)).toEqual(["email", "slack"]);
  });
});

describe("taskfollow add (D134)", () => {
  it("switches a single choice to the new service and shows its steps, even after the install was finished", async () => {
    const { deps, state, events } = await finish(SOLUTION, [["services.chat", "none"], ["services.records", "google-sheets"], ["sheet-step", "x"], ["last", "y"]]);
    const added = await addService(deps, state, "email");
    expect(added.state.steps["services.chat"]).toMatchObject({ status: "done", value: "email" });
    expect(added.result).toMatchObject({ status: "step", view: { step: { step_id: "email-step" } } });
    expect(events.at(-1)).toMatchObject({ event: "step.revised", ref: "services.chat", actor: "agent" });
  });

  it("adds to a multiple choice without losing what was chosen", async () => {
    const { deps, state } = await answered(MANY, [["services.apps", ["telegram"]]]);
    const added = await addService(deps, state, "email");
    expect(added.state.steps["services.apps"]?.value).toEqual(["telegram", "email"]);
    expect(added.result).toMatchObject({ view: { step: { step_id: "email-step" } } });
  });

  it("says plainly when the service is already set up", async () => {
    const { deps, state } = await answered(SOLUTION, [["services.chat", "email"], ["services.records", "none"]]);
    await expect(addService(deps, state, "email")).rejects.toThrow("already part of this setup");
  });

  it("names what can be added when asked for something else, and never guesses", async () => {
    const { deps, state } = await answered(SOLUTION, [["services.chat", "none"], ["services.records", "none"]]);
    await expect(addService(deps, state, "outlook")).rejects.toThrow(InputError);
    await expect(addService(deps, state, "outlook")).rejects.toThrow("email, google-sheets");
  });

  it("asks to finish the install questions first", async () => {
    const { deps, state } = await answered(SOLUTION, []);
    await expect(addService(deps, state, "email")).rejects.toThrow("answer");
  });

  it("explains that an install made before services could be chosen cannot add them", async () => {
    const plain = parseSolution({ id: "p", version: "1", steps: [ask("a")] });
    const { deps, state } = await answered(plain, [["a", "x"]]);
    await expect(addService(deps, state, "email")).rejects.toThrow("before services could be chosen");
  });
});

describe("the report offers what can be added (D134)", () => {
  it("lists the options not chosen, with the command", async () => {
    const { state } = await answered(SOLUTION, [["services.chat", "none"], ["services.records", "google-sheets"]]);
    const report = buildReport(SOLUTION, state);
    expect(report.can_add).toEqual(["email"]);
    expect(renderReport(report)).toContain("taskfollow add email");
  });

  it("says nothing when there is nothing to add", async () => {
    const { state } = await answered(SOLUTION, [["services.chat", "email"], ["services.records", "google-sheets"]]);
    expect(renderReport(buildReport(SOLUTION, state))).not.toContain("Can add");
  });
});
