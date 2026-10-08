import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { ActionFailure } from "../../src/core/failure.js";
import { TOOLS_MCP_NAME, installerCliPath, toolsServerConfig } from "../../src/core/register.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import type { InstallState } from "../../src/core/types.js";
import { makeTempHome } from "../helpers/temp-home.js";

let agentHome = "";

beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const probed = { schema: 1, solution: { ref: "file:/s.json", id: "s", version: "1" }, started_at: "t", steps: {}, runtime: { profile: "fake-agent" } } as unknown as InstallState;
const STEP = { phase: "PREFLIGHT", type: "auto", title: "t", why: "w", blocking: true };

describe("register_tools_mcp (D56)", () => {
  it("names the server 'installer' and runs the built CLI with this home over stdio", () => {
    expect(TOOLS_MCP_NAME).toBe("installer");
    expect(JSON.parse(toolsServerConfig("/usr/bin/node", "/opt/installer/dist/cli.js", "/home/o'brien/.installer"))).toEqual({
      type: "stdio", command: "/usr/bin/node", args: ["/opt/installer/dist/cli.js", "--home", "/home/o'brien/.installer", "mcp-serve"],
    });
  });

  it("registers the local server in the probed agent, and again without complaint", async () => {
    const home = await makeTempHome();
    await runAction(home, { action: "register_tools_mcp" }, probed);
    await runAction(home, { action: "register_tools_mcp" }, probed);
    const stored = JSON.parse(await readFile(join(agentHome, "mcp", "installer.json"), "utf8"));
    expect(stored).toEqual({ type: "stdio", command: process.execPath, args: [installerCliPath(), "--home", resolve(home), "mcp-serve"] });
  });

  it("needs a probed agent, and says how to work without one", async () => {
    await expect(runAction(await makeTempHome(), { action: "register_tools_mcp" })).rejects.toThrow(ActionFailure);
    await expect(runAction(await makeTempHome(), { action: "register_tools_mcp" })).rejects.toThrow("or use 'installer tool' instead");
  });

  it("is refused in a solution before the probe step", () => {
    const steps = [{ ...STEP, step_id: "a", auto: { action: "register_tools_mcp" } }, { ...STEP, step_id: "b", auto: { action: "probe_runtime" } }];
    expect(() => parseSolution({ id: "s", version: "1", steps })).toThrow(SolutionError);
    expect(() => parseSolution({ id: "s", version: "1", steps })).toThrow("Step 'a': register_tools_mcp needs an earlier probe_runtime step");
    expect(() => parseSolution({ id: "s", version: "1", steps: [...steps].reverse() })).not.toThrow();
  });
});
