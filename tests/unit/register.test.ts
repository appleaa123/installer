import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { resume, start } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadProfile } from "../../src/core/profile.js";
import { headersHelperCommand, installerCliPath, mcpServerConfig, registerMcp, unregisterMcp } from "../../src/core/register.js";
import { KEY_MISSING_HINT } from "../../src/core/skillswiki.js";
import { parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const MISSING = resolve("tests/fixtures/profiles/missing-agent.json");
const URL = "https://wiki.test/mcp";
const HELPER = "'/usr/bin/node' '/opt/installer/dist/cli.js' mcp-headers skillswiki";
let agentHome = "";

const registered = (): Promise<string> => readFile(join(agentHome, "mcp", "skillswiki.json"), "utf8");

beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("headers helper command", () => {
  it("quotes both paths for the agent's shell, even with spaces and quotes (D52)", () => {
    expect(headersHelperCommand("skillswiki", "/opt/my node/bin/node", "/Users/o'brien/dist/cli.js")).toBe(
      "'/opt/my node/bin/node' '/Users/o'\\''brien/dist/cli.js' mcp-headers skillswiki",
    );
  });

  it("names the built CLI by an absolute path", () => {
    expect(installerCliPath()).toBe(resolve("dist/cli.js"));
  });

  it("builds the http server config with the helper and no key", () => {
    expect(JSON.parse(mcpServerConfig(URL, HELPER))).toEqual({ type: "http", url: URL, headersHelper: HELPER });
  });
});

describe("registerMcp against the fake agent", () => {
  it("stores the http config and replaces it when run again (idempotent, fact 3)", async () => {
    const profile = await loadProfile(FAKE);
    await registerMcp(profile, "skillswiki", URL, HELPER, agentHome);
    expect(JSON.parse(await registered())).toEqual({ type: "http", url: URL, headersHelper: HELPER });
    await registerMcp(profile, "skillswiki", "https://other.test/mcp", HELPER, agentHome);
    expect(JSON.parse(await registered())).toMatchObject({ url: "https://other.test/mcp" });
  });

  it("reports a refused registration as a failure the person can retry", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "mcp");
    await expect(registerMcp(await loadProfile(FAKE), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(ActionFailure);
    await expect(registerMcp(await loadProfile(FAKE), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(
      "Could not register the 'skillswiki' MCP server in Fake Agent: the command exited with code 1",
    );
  });

  it("unregisterMcp says whether a server was removed", async () => {
    const profile = await loadProfile(FAKE);
    await registerMcp(profile, "skillswiki", URL, HELPER, agentHome);
    await expect(unregisterMcp(profile, "skillswiki", agentHome)).resolves.toBe(true);
    await expect(unregisterMcp(profile, "skillswiki", agentHome)).resolves.toBe(false);
    await expect(registered()).rejects.toThrow();
  });

  it("refuses a profile without the MCP templates", async () => {
    await expect(registerMcp(await loadProfile(MISSING), "skillswiki", URL, HELPER, agentHome)).rejects.toThrow(/has no mcp_remove template/);
  });
});

describe("register_mcp in an install", () => {
  const steps = [
    { step_id: "pre.probe", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Needed.", blocking: true, auto: { action: "probe_runtime", args: { profile: "fake-agent" } } },
    { step_id: "brain.register", phase: "BRAIN", type: "auto", title: "Register", why: "Needed.", blocking: true, auto: { action: "register_mcp" } },
  ];

  async function install(key?: string) {
    const keychain = await makeTempHome();
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", keychain);
    if (key) await setSecret("skillswiki", key);
    const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "r", version: "1", steps }));
    return { deps, started: await start(deps, null, "file:/r.json", "sha", { skillswiki: { url: URL } }) };
  }

  it("registers Skills Wiki in the probed agent with the installer's own headers helper", async () => {
    const { started } = await install("k-1");
    expect(started.result).toEqual({ status: "complete" });
    expect(JSON.parse(await registered())).toMatchObject({ type: "http", url: URL, headersHelper: expect.stringMatching(/mcp-headers skillswiki$/) });
  });

  it("fails with the key hint when no key is stored, and nothing is registered", async () => {
    const { started } = await install();
    expect(started.result).toMatchObject({ status: "step", view: { step: { step_id: "brain.register" }, status: "failed", hint: KEY_MISSING_HINT } });
    await expect(registered()).rejects.toThrow();
  });

  it("fails, then blocks after three refusals by the agent (D53)", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "mcp");
    const { deps, started } = await install("k-1");
    expect(started.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 1, resume: "taskfollow resume" } });
    const second = await resume(deps, started.state);
    expect(second.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 2 } });
    const third = await resume(deps, second.state);
    expect(third.result).toMatchObject({ status: "blocked", view: { attempts: 3, hint: expect.stringContaining("Could not register") } });
  });

  it("needs a probed agent", async () => {
    await expect(runAction(await makeTempHome(), { action: "register_mcp" })).rejects.toThrow("The probe found no known agent");
  });
});
