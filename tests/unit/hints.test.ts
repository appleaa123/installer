import { describe, expect, it } from "vitest";
import { advance, resume, start, submit, verifyStep } from "../../src/core/engine.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import type { CapabilityMap } from "../../src/core/types.js";
import { FIXTURE_REF, basicSolution, memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const agentStep = (hints: unknown) => ({
  step_id: "brain.do", phase: "BRAIN", type: "agent_action", title: "Do it", why: "Needed.", blocking: true,
  intent: "Create config/done.txt", verify: { check: "file_exists", args: { path: "config/done.txt" } }, hints,
});
const runtime = (profile: string | null): CapabilityMap => ({
  profile, agent_version: "1.0.0", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
});
const HINTS = { "claude-code": ["Use the Write tool.", "Then run the verify command."] };

async function viewWith(profile: string | null | undefined) {
  const solution = parseSolution({ id: "h", version: "1", steps: [agentStep(HINTS)] });
  const { deps } = memoryDeps(await makeTempHome(), solution);
  const { state } = await start(deps, null, "file:/h.json");
  const withRuntime = profile === undefined ? state : { ...state, runtime: runtime(profile) };
  return (await advance(deps, withRuntime)).result;
}

describe("hints", () => {
  it("shows the hints for the probed agent", async () => {
    expect(await viewWith("claude-code")).toMatchObject({ status: "step", view: { hints: HINTS["claude-code"] } });
  });

  it.each([["another agent", "codex"], ["an unknown agent", null], ["no probe yet", undefined]])("shows no hints for %s", async (_name, profile) => {
    const result = await viewWith(profile);
    expect(result.status === "step" && result.view.hints).toBeFalsy();
  });

  it.each([
    ["a profile id with spaces", { "claude code": ["x"] }],
    ["an empty list", { "claude-code": [] }],
    ["a non-object", ["x"]],
  ])("refuses %s", (_name, hints) => {
    expect(() => parseSolution({ id: "h", version: "1", steps: [agentStep(hints)] })).toThrow(SolutionError);
  });
});

describe("a reopened agent_action", () => {
  it("names installer verify, not installer resume", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    let { state } = await start(deps, null, FIXTURE_REF);
    state = (await submit(deps, state, "mode.shared-work", { kind: "value", value: "yes" })).state;
    state = (await submit(deps, state, "mode.report-time", { kind: "value", value: "09:00" })).state;
    state = (await verifyStep(deps, state, "brain.register")).state;
    const reopened = await resume(deps, state);
    expect(reopened.result).toMatchObject({ status: "step", view: { status: "pending", attempts: 1, resume: "installer verify brain.register" } });
  });
});
