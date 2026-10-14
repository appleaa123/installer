import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_KEYS, NOT_RUN, certify, type CertifyDeps, type SuiteResult } from "../../src/core/certify.js";
import { checkoutState, requireCheckout, suiteFromReport, vitestSuites } from "../../src/core/certify-runs.js";
import { InputError } from "../../src/core/inputs.js";
import { unknownRuntime } from "../../src/core/probe.js";
import type { CapabilityMap } from "../../src/core/types.js";
import { FAKE_RUNTIME } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

afterEach(() => vi.unstubAllEnvs());

const AT = "2026-10-09T12:00:00.000Z";
const PASSED: SuiteResult = { status: "passed", files: 93, tests: 1241, passed: 1241, failed: 0, skipped: 0 };
const LIVE_PASSED: SuiteResult = { status: "passed", files: 7, tests: 12, passed: 12, failed: 0, skipped: 0 };
const ALL_KEYS = { ...Object.fromEntries(LIVE_KEYS.map((name) => [name, `value-of-${name}`])), INSTALLER_LIVE_AGENT: "1" };
const CLAUDE: CapabilityMap = { ...FAKE_RUNTIME, profile: "claude-code", agent_version: "2.1.294" };

/** Fakes for everything certify runs; `runs` lists each suite it asked for. */
function fakes(over: Partial<CertifyDeps> & { offline?: SuiteResult; live?: SuiteResult; map?: CapabilityMap } = {}): CertifyDeps & { readonly runs: [boolean, string][] } {
  const runs: [boolean, string][] = [];
  return {
    runs,
    runSuite: async (live, profile) => {
      runs.push([live, profile]);
      return live ? (over.live ?? LIVE_PASSED) : (over.offline ?? PASSED);
    },
    probe: async () => over.map ?? CLAUDE,
    checkout: async () => ({ commit: "abc1234", dirty: false }),
    version: "0.1.0", env: ALL_KEYS, platform: "darwin arm64", now: () => AT,
    ...over,
  };
}

describe("taskpilot certify, the local certification (D116)", () => {
  it("needs a profile", async () => {
    await expect(certify(await makeTempHome(), undefined, fakes())).rejects.toThrow(InputError);
  });

  it("runs the offline suite, then the live checks for the profile, probes the agent and writes a dated record", async () => {
    const home = await makeTempHome();
    const deps = fakes({ map: FAKE_RUNTIME, env: {} });
    const record = await certify(home, "fake-agent", deps);
    expect(deps.runs).toEqual([[false, "fake-agent"], [true, "fake-agent"]]);
    expect(record.file).toBe(join(home, "certification", "2026-10-09T12-00-00-000Z-fake-agent.json"));
    const { file, ...written } = record;
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(written);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(written).toMatchObject({
      format: 1, at: AT, profile: "fake-agent", agent_version: "9.9.9", platform: "darwin arm64", installer: "0.1.0", commit: "abc1234", dirty: false,
      offline: PASSED, live: { ...LIVE_PASSED, missing: [...LIVE_KEYS, "INSTALLER_LIVE_AGENT=1"] }, probe: FAKE_RUNTIME, tos_review: "ok", tier: "compatible",
    });
    expect(written.reasons).toEqual([`the live checks lacked ${[...LIVE_KEYS, "INSTALLER_LIVE_AGENT=1"].join(", ")}`, "the profile is not one the installer ships"]);
  });

  it("certifies a shipped profile with reviewed terms only when everything ran and passed from a clean checkout", async () => {
    const record = await certify(await makeTempHome(), "claude-code", fakes());
    expect(record).toMatchObject({ profile: "claude-code", agent_version: "2.1.294", tier: "certified", reasons: [] });
  });

  it.each([
    ["a failed offline suite, which also skips the live checks", { offline: { ...PASSED, status: "failed", failed: 2 } as SuiteResult }, ["the offline suite failed", "the live checks did not run"], "compatible"],
    ["failed live checks", { live: { ...LIVE_PASSED, status: "failed", failed: 1 } as SuiteResult }, ["the live checks failed"], "compatible"],
    ["live checks that passed with some skipped", { live: { ...LIVE_PASSED, skipped: 1 } as SuiteResult }, ["the live checks skipped 1 test"], "compatible"],
    ["a live key that is not set", { env: { ...ALL_KEYS, TELEGRAM_BOT_TOKEN: "" } }, ["the live checks lacked TELEGRAM_BOT_TOKEN"], "compatible"],
    ["no C6 rehearsal", { env: { ...ALL_KEYS, INSTALLER_LIVE_AGENT: "" } }, ["the live checks lacked INSTALLER_LIVE_AGENT=1"], "compatible"],
    ["an agent without session resume", { map: { ...CLAUDE, c5_resume: false } }, ["the agent did not pass C4, C4 schema and C5"], "compatible"],
    ["an agent older than the profile's minimum", { map: { ...CLAUDE, agent_version: "2.0.1" } }, ["the agent's version is unknown or older than 2.1.0"], "unknown"],
    ["no agent at all", { map: unknownRuntime("No known agent was found; fallbacks will apply") }, ["the agent did not pass C4, C4 schema and C5", "the agent's version is unknown or older than 2.1.0"], "unknown"],
    ["changes that are not committed", { checkout: async () => ({ commit: "abc1234", dirty: true }) }, ["the checkout has changes that are not committed"], "compatible"],
  ])("does not certify after %s, and says why", async (_name, over, reasons, tier) => {
    const deps = fakes(over as Parameters<typeof fakes>[0]);
    const record = await certify(await makeTempHome(), "claude-code", deps);
    expect(record).toMatchObject({ tier, reasons });
    if (reasons[0] === "the offline suite failed") expect(deps.runs).toEqual([[false, "claude-code"]]);
  });

  it("keeps a profile whose vendor terms are under review at Unknown, whatever passed (D32, O2)", async () => {
    const dir = await makeTempHome();
    const base = JSON.parse(await readFile("profiles/codex.json", "utf8")) as Record<string, unknown>;
    await writeFile(join(dir, "pending-agent.json"), JSON.stringify({ ...base, id: "pending-agent", tos_review: { status: "pending", note: "Not reviewed." } }));
    vi.stubEnv("INSTALLER_PROFILE_DIR", dir);
    const record = await certify(await makeTempHome(), "pending-agent", fakes({ map: { ...CLAUDE, profile: "pending-agent", agent_version: "0.50.0" } }));
    expect(record).toMatchObject({ tos_review: "pending", tier: "unknown", reasons: expect.arrayContaining(["the vendor's terms are not reviewed (tos_review: pending)"]) });
  });

  it("names the live keys by name only: no value reaches the record", async () => {
    const record = await certify(await makeTempHome(), "claude-code", fakes());
    expect(await readFile(record.file, "utf8")).not.toContain("value-of-");
  });
});

describe("what certify runs for real (D116)", () => {
  it("reads vitest's JSON report: passed, failed, all skipped, or none written", () => {
    const report = { numTotalTests: 5, numPassedTests: 4, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, numFailedTestSuites: 0, success: true, testResults: [{}, {}] };
    expect(suiteFromReport(report, 0)).toEqual({ status: "passed", files: 2, tests: 5, passed: 4, failed: 0, skipped: 1 });
    expect(suiteFromReport({ ...report, numFailedTests: 1, success: false }, 1)).toMatchObject({ status: "failed", failed: 1, note: "vitest exited with code 1; 0 file(s) could not run" });
    expect(suiteFromReport({ ...report, numPassedTests: 0, numPendingTests: 5 }, 0)).toMatchObject({ status: "passed", passed: 0, skipped: 5 });
    expect(suiteFromReport(null, 1)).toEqual({ ...NOT_RUN("vitest exited with code 1 and wrote no report"), status: "failed" });
  });

  it("runs no suite while the test suite itself is running (INSTALLER_CERTIFY_SUITES=none)", async () => {
    await expect(vitestSuites("/nowhere", { INSTALLER_CERTIFY_SUITES: "none" })(false, "claude-code")).resolves.toEqual(NOT_RUN("INSTALLER_CERTIFY_SUITES=none"));
  });

  it("refuses to run outside a source checkout", async () => {
    await expect(requireCheckout(await makeTempHome())).rejects.toThrow("runs from a source checkout");
  });

  it("calls a folder without git unknown and not clean", async () => {
    await expect(checkoutState(await makeTempHome())).resolves.toEqual({ commit: "unknown", dirty: true });
  });
});
