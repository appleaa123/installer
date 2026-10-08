import { describe, expect, it } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { start, submit } from "../../src/core/engine.js";
import { InputError } from "../../src/core/inputs.js";
import { deriveMode } from "../../src/core/mode.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ask = (step_id: string, input: object) => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input });
const derive = (args: object) => ({ step_id: "mode.derive", phase: "MODE", type: "auto", title: "Work out the mode", why: "Sets up the right shape.", blocking: true, auto: { action: "derive_mode", args } });
const ARGS = { shared_work: "q1", always_on: "q2", decision_maker: "q3" };
const QUESTIONS = [ask("q1", { kind: "choice", options: ["no", "yes", "both"] }), ask("q2", { kind: "choice", options: ["no", "yes"] }), ask("q3", { kind: "text" })];

describe("deriveMode (spec §5)", () => {
  it.each([
    ["no", "no", "personal"],
    ["yes", "no", "team_host"],
    ["no", "yes", "team_host"],
    ["yes", "yes", "team_host"],
    ["both", "no", "hybrid"],
    ["both", "yes", "hybrid"],
  ])("shared work %s, always on %s → %s", (shared, alwaysOn, mode) => {
    expect(deriveMode(shared, alwaysOn)).toBe(mode);
  });

  it.each([["maybe", "no"], ["yes", "sometimes"]])("refuses the answers %s / %s", (shared, alwaysOn) => {
    expect(() => deriveMode(shared, alwaysOn)).toThrow(InputError);
  });
});

describe("probe_runtime arguments (D34)", () => {
  const probe = (profile: unknown) => ({ step_id: "p", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Probe.", blocking: true, auto: { action: "probe_runtime", args: { profile } } });

  it.each(["/tmp/evil.json", "../profiles/x.json", "Claude", 5])("refuses the profile %s", (profile) => {
    expect(() => parseSolution({ id: "p", version: "1", steps: [probe(profile)] })).toThrow(/must be a runtime profile id/);
  });

  it("accepts a profile id", () => {
    expect(parseSolution({ id: "p", version: "1", steps: [probe("claude-code")] }).steps[0]?.auto?.args).toEqual({ profile: "claude-code" });
  });
});

describe("derive_mode in an install", () => {
  it("stores the mode and the decision maker after the three answers", async () => {
    const solution = parseSolution({ id: "m", version: "1", steps: [...QUESTIONS, derive(ARGS)] });
    const { deps } = memoryDeps(await makeTempHome(), solution);
    let { state } = await start(deps, null, "file:/m.json");
    state = (await submit(deps, state, "q1", { kind: "value", value: "yes" })).state;
    state = (await submit(deps, state, "q2", { kind: "value", value: "no" })).state;
    const last = await submit(deps, state, "q3", { kind: "value", value: "  Office manager " });
    expect(last.result).toEqual({ status: "complete" });
    expect(last.state).toMatchObject({ mode: "team_host", roles: { decision_maker: "Office manager" } });
  });

  it("refuses to run before its answers exist", async () => {
    await expect(runAction(await makeTempHome(), { action: "derive_mode", args: ARGS })).rejects.toThrow("derive_mode needs step 'q1' to be answered first");
  });

  it.each([
    ["a step that does not exist", { ...ARGS, shared_work: "q9" }, [...QUESTIONS, derive({ ...ARGS, shared_work: "q9" })]],
    ["a step that comes after it", ARGS, [QUESTIONS[0], QUESTIONS[1], derive(ARGS), QUESTIONS[2]]],
    ["a missing argument", { shared_work: "q1", always_on: "q2" }, [...QUESTIONS, derive({ shared_work: "q1", always_on: "q2" })]],
    ["a shared-work question that takes free text", ARGS, [ask("q1", { kind: "text" }), QUESTIONS[1], QUESTIONS[2], derive(ARGS)]],
    ["an always-on question with an answer derive_mode cannot use", ARGS, [QUESTIONS[0], ask("q2", { kind: "choice", options: ["no", "yes", "sometimes"] }), QUESTIONS[2], derive(ARGS)]],
    ["a decision-maker question that is a choice", ARGS, [QUESTIONS[0], QUESTIONS[1], ask("q3", { kind: "choice", options: ["a", "b"] }), derive(ARGS)]],
  ])("refuses a solution whose derive_mode names %s (Review Focus 4)", (_name, _args, steps) => {
    expect(() => parseSolution({ id: "m", version: "1", steps })).toThrow(SolutionError);
    expect(() => parseSolution({ id: "m", version: "1", steps })).toThrow(/derive_mode args\.\w+ must name an earlier ask step/);
  });
});
