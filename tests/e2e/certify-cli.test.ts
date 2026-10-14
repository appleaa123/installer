import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** The test suite sets INSTALLER_CERTIFY_SUITES=none, so certify runs no suite here; the real run is a person's task. */
describe("taskpilot certify (D116)", () => {
  it("needs a profile", async () => {
    const result = runCli(["certify"], { home: await makeTempHome() });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: "certify needs --profile <id>, for example: taskpilot certify --profile claude-code" });
  });

  it("names a profile that does not exist", async () => {
    const result = runCli(["certify", "--profile", "no-such-agent"], { home: await makeTempHome() });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: "Unknown runtime profile 'no-such-agent'" });
  });

  it("probes the agent, runs no suite inside the test run, and writes a record that is never Certified", async () => {
    const home = await makeTempHome();
    const result = runCli(["certify", "--profile", "fake-agent"], { home });
    expect(result.code).toBe(0);
    const record = result.json as { file: string; tier: string; reasons: string[]; installer: string };
    expect(record).toMatchObject({ profile: "fake-agent", agent_version: "9.9.9", offline: { status: "not_run", note: "INSTALLER_CERTIFY_SUITES=none" }, live: { status: "not_run" }, tier: "compatible" });
    expect(record.reasons).toEqual(expect.arrayContaining(["the offline suite did not run", "the live checks did not run", "the profile is not one the installer ships"]));
    expect(record.installer).toBe(JSON.parse(await readFile("package.json", "utf8")).version);
    expect(record.file.startsWith(`${home}/certification/`)).toBe(true);
    expect(JSON.parse(await readFile(record.file, "utf8"))).toMatchObject({ tier: "compatible" });
  });
});
