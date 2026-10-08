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

describe("loadSolution", () => {
  it("loads a file: reference", async () => {
    await expect(loadSolution(`file:${FIXTURE}`)).resolves.toMatchObject({ id: "fixture-basic" });
  });

  it("rejects unsupported references", async () => {
    await expect(loadSolution("https://example.com/solution.json")).rejects.toThrow(/only file:/);
  });

  it("reports unreadable and invalid files", async () => {
    const home = await makeTempHome();
    await expect(loadSolution(`file:${join(home, "missing.json")}`)).rejects.toThrow(/Cannot read/);
    const bad = join(home, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    await expect(loadSolution(`file:${bad}`)).rejects.toThrow(/not valid JSON/);
  });
});
