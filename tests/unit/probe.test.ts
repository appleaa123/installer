import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProfile } from "../../src/core/profile.js";
import { runProbe } from "../../src/core/probe.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const MISSING = resolve("tests/fixtures/profiles/missing-agent.json");

async function probe(drop?: string, timeoutMs?: number) {
  if (drop) vi.stubEnv("FAKE_AGENT_DROP", drop);
  return runProbe({ profiles: [await loadProfile(FAKE)], cwd: await makeTempHome(), ...(timeoutMs ? { timeoutMs } : {}) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runProbe", () => {
  it("finds every capability on a working agent", async () => {
    expect(await probe()).toEqual({
      profile: "fake-agent", agent_version: "9.9.9", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
      c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
    });
  });

  it("records a missing structured output", async () => {
    expect(await probe("schema")).toMatchObject({ c4_headless: true, c4_schema: false, support_level: 2, notes: ["C4 schema: unexpected answer"] });
  });

  it("records a missing session resume", async () => {
    expect(await probe("c5")).toMatchObject({ c5_resume: false, support_level: 1, notes: ["C5 resume: unexpected answer"] });
  });

  it("records a failing headless call and skips the checks that need it", async () => {
    expect(await probe("c4")).toMatchObject({
      c4_headless: false, c4_schema: false, c5_resume: false, support_level: 0, tier: "unknown", notes: ["C4 headless: the agent exited with code 1"],
    });
  });

  it("records an agent that hangs as timed out (Review Focus 1)", async () => {
    expect(await probe("hang", 500)).toMatchObject({ c4_headless: false, notes: ["C4 headless: the agent timed out after 500 ms"] });
  });

  it("records an agent that prints non-JSON (Review Focus 1)", async () => {
    expect(await probe("json")).toMatchObject({ c4_headless: false, notes: ["C4 headless: the agent did not print JSON"] });
  });

  it("returns an unknown runtime when no profile's agent is installed (Review Focus 2)", async () => {
    const map = await runProbe({ profiles: [await loadProfile(MISSING)], cwd: await makeTempHome() });
    expect(map).toMatchObject({ profile: null, tier: "unknown", support_level: 0, notes: ["No known agent was found; fallbacks will apply"] });
  });

  it("uses the first profile whose agent is installed", async () => {
    const map = await runProbe({ profiles: [await loadProfile(MISSING), await loadProfile(FAKE)], cwd: await makeTempHome() });
    expect(map.profile).toBe("fake-agent");
  });
});
