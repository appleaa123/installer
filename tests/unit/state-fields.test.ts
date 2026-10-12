import { describe, expect, it } from "vitest";
import { isInstallState } from "../../src/core/state.js";

const base = { schema: 1, solution: { ref: "file:/s.json", id: "s", version: "1" }, started_at: "2026-01-01T00:00:00.000Z", steps: {} };
const runtime = {
  profile: "claude-code", agent_version: "2.1.294", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
};

describe("install state fields added by Plan 2", () => {
  it("accepts recipe_version, mode, roles and runtime", () => {
    const state = { ...base, solution: { ...base.solution, recipe_version: "abc" }, mode: "team_host", roles: { decision_maker: "Owner" }, runtime };
    expect(isInstallState(state)).toBe(true);
  });

  it("still accepts a Plan 1 state without them", () => {
    expect(isInstallState(base)).toBe(true);
  });

  it("accepts the Plan 3 fields skillswiki and work_dir", () => {
    expect(isInstallState({ ...base, skillswiki: { url: "https://wiki.test/mcp" }, work_dir: "/work" })).toBe(true);
  });

  it.each([
    ["an unknown mode", { ...base, mode: "boss" }],
    ["roles without a decision maker", { ...base, roles: {} }],
    ["a non-string recipe_version", { ...base, solution: { ...base.solution, recipe_version: 5 } }],
    ["a runtime without a support level", { ...base, runtime: { profile: null } }],
    ["a skillswiki entry without a url", { ...base, skillswiki: {} }],
    ["a non-string work_dir", { ...base, work_dir: 7 }],
  ])("rejects %s", (_name, state) => {
    expect(isInstallState(state)).toBe(false);
  });
});
