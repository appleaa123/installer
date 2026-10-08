import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_PATH, FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const LIVE_RETRY_PATH = resolve("tests/fixtures/live-retry.json");

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

  it.skipIf(process.platform === "win32")("refuses an existing home other users can open, and leaves its mode alone (D34)", async () => {
    const home = await makeTempHome();
    await chmod(home, 0o755);
    const result = runCli(["start", "--solution", FIXTURE_REF], { home });
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ error: `${home} can be opened by other users (mode 755); run 'chmod 700 ${home}' or use a different --home`, code: 2 });
    expect((await stat(home)).mode & 0o777).toBe(0o755);
    await expect(readdir(home)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === "win32")("accepts an existing home that only its owner can open", async () => {
    const home = await makeTempHome();
    await chmod(home, 0o700);
    expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
  });

  it.each([
    ["INSTALLER_HOME is empty", { INSTALLER_HOME: "" }],
    ["--home is empty", { home: "" }],
  ])("falls back to ~/.installer when %s", async (_name, extra) => {
    const fakeHome = await makeTempHome();
    const cwd = await makeTempHome();
    const { home, ...envOnly } = extra as { home?: string; INSTALLER_HOME?: string };
    const result = runCli(["start", "--solution", FIXTURE_REF], {
      cwd,
      ...(home === undefined ? {} : { home }),
      env: { HOME: fakeHome, INSTALLER_HOME: "", ...envOnly },
    });
    expect(result.code).toBe(0);
    await expect(access(statePath(join(fakeHome, ".installer")))).resolves.toBeUndefined();
    await expect(readdir(cwd)).resolves.toEqual([]);
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

  it.each([["--force"], ["--force=1"], ["-f"]])("names the unknown option %s and lists the valid ones", async (option) => {
    const home = await makeTempHome();
    const result = runCli(["next", option], { home });
    const raw = option.split("=")[0];
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ error: `Unknown option '${raw}'. Options: --home, --solution, --value, --done, --json, --profile`, code: 2 });
  });

  it("records the solution's content sha as recipe_version", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const sha = createHash("sha256").update(await readFile(FIXTURE_PATH, "utf8")).digest("hex");
    expect((await loadState(home))?.solution.recipe_version).toBe(sha);
  });

  it.each(["http://example.test/s.json", "skillswiki:pack/skill/recipe.json"])("refuses %s with exit 2 and creates nothing", async (ref) => {
    const home = join(await makeTempHome(), "engine");
    const result = runCli(["start", "--solution", ref], { home });
    expect(result.code).toBe(2);
    await expect(access(home)).rejects.toThrow();
  });

  describe("runtime probe", () => {
    const FAKE_PROFILE = resolve("tests/fixtures/profiles/fake-agent.json");

    async function probeSolution(): Promise<string> {
      const path = join(await makeTempHome(), "probe.json");
      const steps = [
        { step_id: "preflight.probe", phase: "PREFLIGHT", type: "auto", title: "Check the agent", why: "Finds what the agent can do.", blocking: true, auto: { action: "probe_runtime", args: { profile: FAKE_PROFILE } } },
        { step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Marks the end.", blocking: true, auto: { action: "noop" } },
      ];
      await writeFile(path, JSON.stringify({ id: "probe-only", version: "1.0.0", steps }), "utf8");
      return `file:${path}`;
    }

    it("installer probe prints the capability map", () => {
      const result = runCli(["probe", "--profile", FAKE_PROFILE], {});
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ profile: "fake-agent", c4_headless: true, c5_resume: true, support_level: 2 });
    });

    it("installer probe names an unknown profile, exit 2", () => {
      const result = runCli(["probe", "--profile", "no-such-agent"], {});
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Unknown runtime profile 'no-such-agent'" });
    });

    it("the probe_runtime step stores the capability map in the state", async () => {
      const home = await makeTempHome();
      expect(runCli(["start", "--solution", await probeSolution()], { home }).json).toEqual({ status: "complete" });
      expect((await loadState(home))?.runtime).toMatchObject({ profile: "fake-agent", support_level: 2 });
    });

    it("a kill right after the probe runs it again on resume and keeps one result", async () => {
      const home = await makeTempHome();
      const crashed = runCli(["start", "--solution", await probeSolution()], { home, env: { INSTALLER_CRASH_AT: "engine:after-action" } });
      expect(crashed.signal).toBe("SIGKILL");
      expect((await loadState(home))?.runtime).toBeUndefined();
      expect(runCli(["resume"], { home }).json).toEqual({ status: "complete" });
      expect((await loadState(home))?.runtime).toMatchObject({ profile: "fake-agent" });
    });
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

  it("accepts a negative number in the --value=<json> form", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "config"));
    await writeFile(join(home, "config", "late-marker.txt"), "ok\n", "utf8");
    runCli(["start", "--solution", `file:${LIVE_RETRY_PATH}`], { home });
    runCli(["submit", "mode.name", "--value", '"North team"'], { home });
    const result = runCli(["submit", "mode.size", "--value=-5"], { home });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "step", view: { step: { step_id: "channels.manual" } } });
  });

  it("exits 3 and leaves the audit file untouched when its last line is damaged", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const file = join(home, AUDIT_FILE);
    const rows = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    await writeFile(file, `${rows.slice(0, -1).join("\n")}\n${rows.at(-1)?.slice(0, 20)}\n`, "utf8");
    const before = await readFile(file, "utf8");
    const result = runCli(["submit", "mode.shared-work", "--value", '"yes"'], { home });
    expect(result.code).toBe(3);
    expect(result.json).toMatchObject({ code: 3, error: expect.stringContaining("damaged last line") });
    await expect(readFile(file, "utf8")).resolves.toBe(before);
  });

  describe("pinned solution", () => {
    async function copyOfFixture(transform: (text: string) => string = (text) => text): Promise<string> {
      const path = join(await makeTempHome(), "solution.json");
      await writeFile(path, transform(await readFile(FIXTURE_PATH, "utf8")), "utf8");
      return `file:${path}`;
    }

    it("keeps working after the source solution file is moved", async () => {
      const home = await makeTempHome();
      const ref = await copyOfFixture();
      const path = ref.slice("file:".length);
      expect(runCli(["start", "--solution", ref], { home }).code).toBe(0);
      await rename(path, `${path}.moved`);
      expect(runCli(["next"], { home }).code).toBe(0);
      expect(runCli(["report"], { home }).stdout).toContain("IN PROGRESS");
    });

    it("accepts a second start from a copy of the same file and changes nothing", async () => {
      const home = await makeTempHome();
      runCli(["start", "--solution", FIXTURE_REF], { home });
      const before = await readFile(statePath(home), "utf8");
      expect(runCli(["start", "--solution", await copyOfFixture()], { home }).code).toBe(0);
      await expect(readFile(statePath(home), "utf8")).resolves.toBe(before);
    });

    it("refuses a second start whose content differs, exit 2", async () => {
      const home = await makeTempHome();
      runCli(["start", "--solution", FIXTURE_REF], { home });
      const changed = await copyOfFixture((text) => text.replace("Is there shared work?", "Is there shared effort?"));
      const result = runCli(["start", "--solution", changed], { home });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: expect.stringContaining("different solution content") });
    });

    it("names the missing pinned file when it is gone", async () => {
      const home = await makeTempHome();
      runCli(["start", "--solution", FIXTURE_REF], { home });
      await rm(join(home, "solution", "solution.json"));
      const result = runCli(["next"], { home });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("solution.json");
    });
  });
});
