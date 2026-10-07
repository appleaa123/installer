import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

describe("installer CLI", () => {
  it("start prints the first actionable step", async () => {
    const home = await makeTempHome();
    const result = runCli(["start", "--solution", FIXTURE_REF], { home });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "step", view: { step: { step_id: "mode.shared-work" } } });
  });

  it.skipIf(process.platform === "win32")("creates the engine home with mode 0700 (D34)", async () => {
    const home = join(await makeTempHome(), "engine");
    runCli(["start", "--solution", FIXTURE_REF], { home });
    expect((await stat(home)).mode & 0o777).toBe(0o700);
  });

  it.each([["next"], ["resume"], ["report"], ["verify", "x"], ["submit", "x", "--done"]])(
    "%s without an install fails clearly and creates nothing (Review Focus 3)",
    async (...args) => {
      const home = await makeTempHome();
      const result = runCli(args, { home });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: expect.stringContaining("installer start") });
      await expect(access(statePath(home))).rejects.toThrow();
    },
  );

  it("stops with exit 3 on a corrupted state file and leaves it untouched (Review Focus 1)", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "state"), { recursive: true });
    await writeFile(statePath(home), "{ half written", "utf8");
    const result = runCli(["next"], { home });
    expect(result.code).toBe(3);
    await expect(readFile(statePath(home), "utf8")).resolves.toBe("{ half written");
  });

  it("rejects unknown commands, unknown options and bad --value JSON", async () => {
    const home = await makeTempHome();
    expect(runCli(["launch"], { home }).code).toBe(2);
    expect(runCli(["next", "--force"], { home }).code).toBe(2);
    runCli(["start", "--solution", FIXTURE_REF], { home });
    expect(runCli(["submit", "mode.shared-work", "--value", "yes"], { home }).code).toBe(2);
    expect(runCli(["submit", "mode.shared-work", "--value", '"yes"'], { home }).code).toBe(0);
  });

  it("report prints text by default and JSON with --json", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    expect(runCli(["report"], { home }).stdout).toContain("IN PROGRESS");
    expect(runCli(["report", "--json"], { home }).json).toMatchObject({ overall: "in_progress", phase: "MODE" });
  });

  it("verify prints the check result and the next step", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    runCli(["submit", "mode.shared-work", "--value", '"no"'], { home });
    runCli(["submit", "mode.report-time", "--value", '"09:00"'], { home });
    const failed = runCli(["verify", "brain.register"], { home });
    expect(failed.json).toMatchObject({ status: "failed", retry: true, next: { status: "step" } });
  });
});
