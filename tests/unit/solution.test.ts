import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SolutionError, loadSolution, parseSolution } from "../../src/core/solution.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FIXTURE = resolve("tests/fixtures/solution-basic.json");
const basic = (): Record<string, unknown> => JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
const withSteps = (mutate: (steps: Record<string, unknown>[]) => Record<string, unknown>[]): Record<string, unknown> => {
  const raw = basic();
  return { ...raw, steps: mutate(raw.steps as Record<string, unknown>[]) };
};

describe("parseSolution", () => {
  it("accepts the basic fixture", () => {
    const solution = parseSolution(basic());
    expect(solution.id).toBe("fixture-basic");
    expect(solution.steps).toHaveLength(7);
  });

  it("rejects duplicate step ids", () => {
    const raw = withSteps((steps) => [...steps, { ...steps[2] }]);
    expect(() => parseSolution(raw)).toThrow(/duplicate/i);
  });

  it("rejects steps out of phase order", () => {
    const raw = withSteps((steps) => [steps[2] ?? {}, steps[0] ?? {}, ...steps.slice(3)]);
    expect(() => parseSolution(raw)).toThrow(/earlier than the previous step/);
  });

  it.each([
    ["ask without input", (s: Record<string, unknown>) => ({ ...s, input: undefined }), 2],
    ["choice without options", (s: Record<string, unknown>) => ({ ...s, input: { kind: "choice" } }), 2],
    ["unknown auto action", (s: Record<string, unknown>) => ({ ...s, auto: { action: "format_disk" } }), 0],
    ["agent_action without verify", (s: Record<string, unknown>) => ({ ...s, verify: undefined }), 4],
    ["agent_action without intent", (s: Record<string, unknown>) => ({ ...s, intent: undefined }), 4],
    ["missing why", (s: Record<string, unknown>) => ({ ...s, why: "" }), 3],
    ["unknown phase", (s: Record<string, unknown>) => ({ ...s, phase: "LATER" }), 6],
  ] as const)("rejects %s", (_name, change, index) => {
    const raw = withSteps((steps) => steps.map((step, i) => (i === index ? change(step) : step)));
    expect(() => parseSolution(raw)).toThrow(SolutionError);
  });
});

describe("secret steps (§8.3)", () => {
  const secret = (extra: Record<string, unknown>) => ({ id: "s", version: "1", steps: [{ step_id: "brain.key", phase: "BRAIN", type: "human_action", title: "Key", why: "Needed.", blocking: true, input: { kind: "secret", provider: "demo" }, ...extra }] });

  it("accepts a step whose provider matches its secret_present check", () => {
    expect(parseSolution(secret({ verify: { check: "secret_present", args: { id: "demo" } } })).steps).toHaveLength(1);
  });

  it.each([
    ["no provider", { input: { kind: "secret" }, verify: { check: "secret_present", args: { id: "demo" } } }, /needs input\.provider/],
    ["a provider that is not a secret id", { input: { kind: "secret", provider: "Demo Key" }, verify: { check: "secret_present", args: { id: "Demo Key" } } }, /needs input\.provider/],
    ["no check", {}, /must verify with/],
    ["a check for another id", { verify: { check: "secret_present", args: { id: "other" } } }, /must verify with/],
    ["a different check", { verify: { check: "file_exists", args: { path: "x" } } }, /must verify with/],
  ])("refuses a secret step with %s", (_name, extra, message) => {
    expect(() => parseSolution(secret(extra))).toThrow(SolutionError);
    expect(() => parseSolution(secret(extra))).toThrow(message);
  });
});
describe("BRAIN step order", () => {
  const auto = (step_id: string, action: string) => ({ step_id, phase: "BRAIN", type: "auto", title: step_id, why: "Needed.", blocking: true, auto: { action } });

  it("refuses register_mcp before probe_runtime", () => {
    expect(() => parseSolution({ id: "b", version: "1", steps: [auto("brain.register", "register_mcp")] })).toThrow("Step 'brain.register': register_mcp needs an earlier probe_runtime step");
  });

  it("accepts register_mcp after probe_runtime", () => {
    expect(parseSolution({ id: "b", version: "1", steps: [auto("pre.probe", "probe_runtime"), auto("brain.register", "register_mcp")] }).steps).toHaveLength(2);
  });
});
describe("loadSolution", () => {
  it("loads a file: reference", async () => {
    await expect(loadSolution(`file:${FIXTURE}`)).resolves.toMatchObject({ id: "fixture-basic" });
  });

  it("rejects unsupported references", async () => {
    await expect(loadSolution("ftp://example.com/solution.json")).rejects.toThrow(/use starter, starter-skillswiki, file:<path> or https:/);
  });

  it("reports unreadable and invalid files", async () => {
    const home = await makeTempHome();
    await expect(loadSolution(`file:${join(home, "missing.json")}`)).rejects.toThrow(/Cannot read/);
    const bad = join(home, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    await expect(loadSolution(`file:${bad}`)).rejects.toThrow(/not valid JSON/);
  });
});

describe("a step's guide (live setup guides, 4.4)", () => {
  const withGuide = (guide: unknown) => ({
    id: "s", version: "1",
    steps: [{ step_id: "a", phase: "PREFLIGHT", type: "human_action", title: "t", why: "w", blocking: true, instructions: ["do it"], guide }],
  });

  it("accepts a guide that names a connector of the catalog", () => {
    expect(parseSolution(withGuide("google-sheets")).steps[0]?.guide).toBe("google-sheets");
  });

  it("keeps a step without a guide as it was", () => {
    const solution = parseSolution({ id: "s", version: "1", steps: [{ step_id: "a", phase: "PREFLIGHT", type: "human_action", title: "t", why: "w", blocking: true }] });
    expect(solution.steps[0]).not.toHaveProperty("guide");
  });

  it.each([["an unknown connector", "nope"], ["a path", "../google-sheets"], ["a number", 7], ["an object-prototype name", "constructor"]])("refuses a guide naming %s", (_name, guide) => {
    expect(() => parseSolution(withGuide(guide))).toThrow(SolutionError);
    expect(() => parseSolution(withGuide(guide))).toThrow("steps[0].guide must name a connector in this installer's catalog");
  });
});

describe("the oauth_ready check (live setup guides, 4.5)", () => {
  const withReady = (id: unknown) => ({
    id: "s", version: "1",
    steps: [{ step_id: "a", phase: "DATA", type: "agent_action", title: "t", why: "w", blocking: true, intent: "do it", verify: { check: "oauth_ready", args: { id } } }],
  });

  it("accepts the sign-in of a connector of the catalog", () => {
    expect(parseSolution(withReady("google")).steps[0]?.verify).toEqual({ check: "oauth_ready", args: { id: "google" } });
  });

  it.each([["a secret that is no connector's sign-in", "skillswiki"], ["nothing", undefined], ["a number", 7]])("refuses %s", (_name, id) => {
    expect(() => parseSolution(withReady(id))).toThrow(SolutionError);
    expect(() => parseSolution(withReady(id))).toThrow("oauth_ready needs args.id, the sign-in secret of a connector");
  });
});

describe("conditional steps and defaults (D131)", () => {
  const ask = (step_id: string, input: object, extra: object = {}) => ({ step_id, phase: "MODE", type: "ask", title: step_id, why: "Needed.", blocking: true, input, ...extra });
  const build = (...steps: object[]) => parseSolution({ id: "s", version: "1", steps });
  const PICK = ask("pick", { kind: "choice", options: ["a", "b"] });
  const MANY = ask("many", { kind: "multi_choice", options: ["x", "y"] });

  it("accepts a step that depends on an earlier choice", () => {
    expect(build(PICK, ask("only-a", { kind: "text" }, { when: { step: "pick", equals: "a" } })).steps[1]?.when).toEqual({ step: "pick", equals: "a" });
    expect(build(MANY, ask("only-x", { kind: "text" }, { when: { step: "many", includes: "x" } })).steps).toHaveLength(2);
  });

  it.each([
    ["names a step that does not exist", { step: "nope", equals: "a" }, "earlier ask step"],
    ["names a step that comes later", { step: "late", equals: "a" }, "earlier ask step"],
    ["asks for a value that is not an option", { step: "pick", equals: "z" }, "one of its options"],
    ["uses includes on a single choice", { step: "pick", includes: "a" }, "multiple choice"],
    ["uses equals on a multiple choice", { step: "many", equals: "x" }, "single choice"],
    ["names no test at all", { step: "pick" }, "equals or includes"],
  ])("refuses a condition that %s", (_what, when, message) => {
    const late = ask("late", { kind: "choice", options: ["a"] });
    expect(() => build(PICK, MANY, ask("dependent", { kind: "text" }, { when }), late)).toThrow(message);
  });

  it("accepts any of several conditions (9.12 item 3)", () => {
    const when = { any: [{ step: "pick", equals: "a" }, { step: "many", includes: "x" }] };
    expect(build(PICK, MANY, ask("either", { kind: "text" }, { when })).steps[2]?.when).toEqual(when);
  });

  it.each([
    ["is an empty any", { any: [] }, "2 to 8"],
    ["is an any of one", { any: [{ step: "pick", equals: "a" }] }, "2 to 8"],
    ["nests an any", { any: [{ any: [{ step: "pick", equals: "a" }, { step: "pick", equals: "b" }] }, { step: "pick", equals: "a" }] }, "cannot hold another any"],
    ["has a part naming a later step", { any: [{ step: "pick", equals: "a" }, { step: "late", equals: "a" }] }, "earlier ask step"],
    ["has a part asking for a value that is not an option", { any: [{ step: "pick", equals: "a" }, { step: "pick", equals: "z" }] }, "one of its options"],
  ])("refuses an any that %s", (_what, when, message) => {
    const late = ask("late", { kind: "choice", options: ["a"] });
    expect(() => build(PICK, MANY, ask("dependent", { kind: "text" }, { when }), late)).toThrow(message);
  });

  it("refuses a condition on a step that is not a choice", () => {
    expect(() => build(ask("name", { kind: "text" }), ask("dependent", { kind: "text" }, { when: { step: "name", equals: "a" } }))).toThrow("single choice");
  });

  it("accepts a suggested workflow that depends on a choice, and refuses a condition that points nowhere", () => {
    const flow = (when: object) => ({ workflow: "w", description: "d", mode: "agentic", instructions: "i", tools: ["memo.list"], when });
    const solution = (when: object) => parseSolution({ id: "s", version: "1", steps: [PICK], workflows: [flow(when)] });
    expect(solution({ step: "pick", equals: "a" }).workflows).toHaveLength(1);
    expect(() => solution({ step: "pick", equals: "z" })).toThrow("one of its options");
    expect(() => solution({ step: "nope", equals: "a" })).toThrow("earlier ask step");
  });

  it("accepts a default that is a valid answer, and refuses one that is not", () => {
    expect(build(ask("pick", { kind: "choice", options: ["a", "b"] }, { default: "a" })).steps[0]?.default).toBe("a");
    expect(() => build(ask("pick", { kind: "choice", options: ["a", "b"] }, { default: "z" }))).toThrow("default");
    expect(build(ask("many", { kind: "multi_choice", options: ["x", "y"] }, { default: ["x"] })).steps[0]?.default).toEqual(["x"]);
  });
});
