import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, STARTER_SCRIPT, operate } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe"];

describe("INSTALL.md", () => {
  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("has the two placeholders the solution server fills in", () => {
    expect(DOC).toContain("{{INSTALL_COMMAND}}");
    expect(DOC).toContain("installer start --solution {{SOLUTION_REF}}");
  });

  it("only names commands the CLI has", () => {
    const named = [...DOC.matchAll(/(?:^|`)installer (\w+)/gm)].map((match) => match[1]);
    expect(named.filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("the shipped starter solution loads and probes with the bundled profiles", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    expect(starter.steps[0]?.auto).toEqual({ action: "probe_runtime", args: {} });
  });
});

describe("starter install, operated the way INSTALL.md says", () => {
  it("ends READY with the mode, decision maker and agent recorded", async () => {
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script: STARTER_SCRIPT });
    expect(run.final.status).toBe("complete");
    expect(await loadState(home)).toMatchObject({ mode: "team_host", roles: { decision_maker: "Owner" }, runtime: { profile: "fake-agent", support_level: 2 } });
    const report = runCli(["report"], { home }).stdout;
    expect(report).toContain("✅ READY  (6 of 6 steps done) · fixture-starter@1.0.0");
    expect(report).toContain("🤖 Agent      fake-agent 9.9.9 — level 2 of 3 (MCP not checked yet)");
  });
});
