import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { start } from "../../src/core/engine.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadProfile } from "../../src/core/profile.js";
import { mcpToolName, probeMcp, withMcpProbe } from "../../src/core/probe.js";
import { headersHelperCommand, installerCliPath, registerMcp } from "../../src/core/register.js";
import { parseSolution } from "../../src/core/solution.js";
import type { CapabilityMap } from "../../src/core/types.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const servers: FakeMcp[] = [];
let cwd = "";

const runtime: CapabilityMap = {
  profile: "fake-agent", agent_version: "9.9.9", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
  c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: ["C4 schema: unexpected answer"],
};

async function wiki(env: Record<string, string> = {}): Promise<FakeMcp> {
  const fake = await startFakeMcp(env);
  servers.push(fake);
  return fake;
}

/** The engine's own registration, so the fake agent finds the helper and the url the way the real one would. */
async function registered(fake: FakeMcp) {
  const profile = await loadProfile(FAKE);
  await registerMcp(profile, "skillswiki", fake.url, headersHelperCommand("skillswiki", process.execPath, installerCliPath()), cwd);
  return profile;
}

beforeEach(async () => {
  cwd = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("skillswiki", "test-key");
});

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.unstubAllEnvs();
});

describe("probeMcp (C6, fact 4)", () => {
  it("passes when the agent reaches Skills Wiki through the registered server and reports the engine's slug", async () => {
    const profile = await registered(await wiki());
    await expect(probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" })).resolves.toEqual({ ok: true });
  });

  it("names the folder whose trust may be missing when the agent cannot run the helper (Review Focus 2)", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "trust");
    const profile = await registered(await wiki());
    const check = await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" });
    expect(check.ok).toBe(false);
    expect(check.note).toBe(`C6 MCP: the agent answered 'headersHelper not run: this workspace has no persisted trust' instead of 'demo-combo'; workspace trust may be missing in ${cwd} (open the agent there once and accept the folder)`);
  });

  it("fails when the agent reports another combo than the engine saw", async () => {
    const profile = await registered(await wiki());
    const check = await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "other-combo" });
    expect(check).toMatchObject({ ok: false, note: expect.stringContaining("answered 'demo-combo' instead of 'other-combo'") });
  });

  it("fails when the agent cannot run at all, without crashing", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "c4");
    const profile = await registered(await wiki());
    expect(await probeMcp({ profile, cwd, serverName: "skillswiki", expectedSlug: "demo-combo" })).toMatchObject({ ok: false, note: expect.stringContaining("the agent exited with code 1") });
  });

  it("names the one tool the agent may use", () => {
    expect(mcpToolName("skillswiki")).toBe("mcp__skillswiki__get_active_combo");
  });
});

describe("withMcpProbe", () => {
  it("records a pass as level 3 and keeps the other notes", () => {
    expect(withMcpProbe(runtime, { ok: true })).toEqual({ ...runtime, c6_mcp: true, support_level: 3 });
  });

  it("records a failure with its note, replacing an older C6 note", () => {
    const once = withMcpProbe(runtime, { ok: false, note: "C6 MCP: first" });
    const twice = withMcpProbe(once, { ok: false, note: "C6 MCP: second" });
    expect(twice).toEqual({ ...runtime, c6_mcp: false, support_level: 2, notes: ["C4 schema: unexpected answer", "C6 MCP: second"] });
  });
});

describe("probe_mcp in an install (D54)", () => {
  const steps = [
    { step_id: "pre.probe", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Needed.", blocking: true, auto: { action: "probe_runtime", args: { profile: "fake-agent" } } },
    { step_id: "brain.register", phase: "BRAIN", type: "auto", title: "Register", why: "Needed.", blocking: true, auto: { action: "register_mcp" } },
    { step_id: "brain.probe-mcp", phase: "BRAIN", type: "auto", title: "Probe MCP", why: "Needed.", blocking: true, auto: { action: "probe_mcp" } },
  ];

  async function install(url: string) {
    const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "p", version: "1", steps }));
    return start(deps, null, "file:/p.json", "sha", { skillswiki: { url }, work_dir: cwd });
  }

  it("runs in the recorded working folder and lifts the support level to 3", async () => {
    const fake = await wiki();
    const { state, result } = await install(fake.url);
    expect(result).toEqual({ status: "complete" });
    expect(state.runtime).toMatchObject({ profile: "fake-agent", c6_mcp: true, support_level: 3, notes: [] });
  });

  it("records a failed C6 with the trust note and still completes the install", async () => {
    vi.stubEnv("FAKE_AGENT_DROP", "trust");
    const fake = await wiki();
    const { state, result } = await install(fake.url);
    expect(result).toEqual({ status: "complete" });
    expect(state.runtime).toMatchObject({ c6_mcp: false, support_level: 2, notes: [expect.stringContaining(`workspace trust may be missing in ${cwd}`)] });
  });

  it("fails with a dashboard hint while no combo is active", async () => {
    const fake = await wiki({ FAKE_MCP_COMBO: "" });
    const { result } = await install(fake.url);
    expect(result).toMatchObject({ status: "step", view: { step: { step_id: "brain.probe-mcp" }, status: "failed", hint: expect.stringContaining("No combo is active") } });
  });

  it("is refused at load time before register_mcp", () => {
    expect(() => parseSolution({ id: "p", version: "1", steps: [steps[0], steps[2]] })).toThrow("Step 'brain.probe-mcp': probe_mcp needs an earlier register_mcp step");
  });
});
