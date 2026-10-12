import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT } from "../../src/core/mcp.js";
import { KEY_MISSING_HINT } from "../../src/core/skillswiki.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { formHeaders, request, waitForExit } from "../helpers/http.js";
import { FIXTURE_PATH, FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const LIVE_RETRY_PATH = resolve("tests/fixtures/live-retry.json");
const RECIPE_PATH = resolve("tests/fixtures/skillswiki/demo/install/recipe.json");
const SKILLSWIKI_REF = "skillswiki:demo/install/recipe.json";

/** A private keychain folder for one test, holding the Skills Wiki key when given. */
async function keychainEnv(key?: string): Promise<Record<string, string>> {
  const dir = await makeTempHome();
  if (key) await setSecret("skillswiki", key, { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir });
  return { INSTALLER_KEYCHAIN_DIR: dir };
}

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
    expect(result.json).toEqual({ error: `Unknown option '${raw}'. Options: --home, --solution, --value, --done, --json, --profile, --url`, code: 2 });
  });

  it("records the solution's content sha as recipe_version", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const sha = createHash("sha256").update(await readFile(FIXTURE_PATH, "utf8")).digest("hex");
    expect((await loadState(home))?.solution.recipe_version).toBe(sha);
  });

  it("refuses http://example.test/s.json with exit 2 and creates nothing", async () => {
    const home = join(await makeTempHome(), "engine");
    const result = runCli(["start", "--solution", "http://example.test/s.json"], { home });
    expect(result.code).toBe(2);
    await expect(access(home)).rejects.toThrow();
  });

  describe("skillswiki: references (D46)", () => {
    const servers: FakeMcp[] = [];

    afterEach(() => {
      servers.splice(0).forEach((fake) => fake.stop());
    });

    async function fakeWiki(env: Record<string, string> = {}): Promise<FakeMcp> {
      const fake = await startFakeMcp(env);
      servers.push(fake);
      return fake;
    }

    it("refuses to start without the key, names the secret command and creates nothing (Review Focus 4)", async () => {
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", "https://wiki.test/mcp"], { home, env: await keychainEnv() });
      expect(result.code).toBe(2);
      expect(result.json).toEqual({ error: KEY_MISSING_HINT, code: 2 });
      await expect(access(home)).rejects.toThrow();
    });

    it.each([
      ["no --url", []],
      ["a plain http url", ["--url", "http://wiki.test/mcp"]],
    ])("refuses to start with %s once the key exists, exit 2, creates nothing (Review Focus 4)", async (_name, urlArgs) => {
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, ...urlArgs], { home, env: await keychainEnv("k-1") });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: expect.stringContaining("--url") });
      await expect(access(home)).rejects.toThrow();
    });

    it("fetches the recipe, pins it and records the url, the working folder and the content sha", async () => {
      const fake = await fakeWiki();
      const [home, cwd] = [await makeTempHome(), await makeTempHome()];
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", fake.url], { home, cwd, env: await keychainEnv(fake.key) });
      expect(result.json).toMatchObject({ status: "step", view: { step: { step_id: "mode.name" } } });
      const recipe = await readFile(RECIPE_PATH, "utf8");
      expect(await loadState(home)).toMatchObject({
        solution: { ref: SKILLSWIKI_REF, id: "fixture-skillswiki", recipe_version: createHash("sha256").update(recipe).digest("hex") },
        skillswiki: { url: fake.url },
        work_dir: await realpath(cwd),
      });
      await expect(readFile(join(home, "solution", "solution.json"), "utf8")).resolves.toBe(recipe);
    });

    it("names a rejected key and creates nothing (Review Focus 3)", async () => {
      const fake = await fakeWiki();
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", SKILLSWIKI_REF, "--url", fake.url], { home, env: await keychainEnv("not-the-key") });
      expect(result.code).toBe(2);
      expect(result.json).toEqual({ error: KEY_REJECTED_HINT, code: 2 });
      await expect(access(home)).rejects.toThrow();
    });

    it("refuses a second start with a different url", async () => {
      const home = await makeTempHome();
      expect(runCli(["start", "--solution", FIXTURE_REF, "--url", "https://one.test/mcp"], { home }).code).toBe(0);
      expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
      const other = runCli(["start", "--solution", FIXTURE_REF, "--url", "https://two.test/mcp"], { home });
      expect(other.code).toBe(2);
      expect(other.json).toMatchObject({ error: expect.stringContaining("already has an install started with the Skills Wiki URL 'https://one.test/mcp'") });
    });
  });

  describe("runtime probe", () => {
    const FAKE_PROFILE = resolve("tests/fixtures/profiles/fake-agent.json");

    async function probeSolution(): Promise<string> {
      const path = join(await makeTempHome(), "probe.json");
      const steps = [
        { step_id: "preflight.probe", phase: "PREFLIGHT", type: "auto", title: "Check the agent", why: "Finds what the agent can do.", blocking: true, auto: { action: "probe_runtime", args: { profile: "fake-agent" } } },
        { step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Marks the end.", blocking: true, auto: { action: "noop" } },
      ];
      await writeFile(path, JSON.stringify({ id: "probe-only", version: "1.0.0", steps }), "utf8");
      return `file:${path}`;
    }

    it("refuses a solution that points probe_runtime at a profile file, and runs nothing (D34)", async () => {
      const dir = await makeTempHome();
      const marker = join(dir, "PWNED");
      const evil = {
        id: "evil", name: "Evil", min_version: "1.0.0",
        detect: { cmd: ["node", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], match: "never" },
        headless: { cmd: ["node", "{prompt}"], result_path: "r", session_path: "s" },
        tos_review: { status: "ok", note: "n" },
      };
      await writeFile(join(dir, "evil.json"), JSON.stringify(evil), "utf8");
      const steps = [{ step_id: "p", phase: "PREFLIGHT", type: "auto", title: "Probe", why: "Probe.", blocking: true, auto: { action: "probe_runtime", args: { profile: join(dir, "evil.json") } } }];
      await writeFile(join(dir, "s.json"), JSON.stringify({ id: "evil", version: "1", steps }), "utf8");
      const home = join(await makeTempHome(), "engine");
      const result = runCli(["start", "--solution", `file:${join(dir, "s.json")}`], { home });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: expect.stringContaining("must be a runtime profile id") });
      await expect(access(marker)).rejects.toThrow();
      await expect(access(home)).rejects.toThrow();
    });

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

  describe("installer secret (D47)", () => {
    const pids: number[] = [];

    afterEach(() => {
      for (const pid of pids.splice(0)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone, which is what the tests expect
        }
      }
    });

    it("prints a waiting url and exits; the page stores one key in the keychain, then exits too", async () => {
      const dir = await makeTempHome();
      const result = runCli(["secret", "skillswiki"], { env: { INSTALLER_KEYCHAIN_DIR: dir } });
      expect(result.code).toBe(0);
      const { status, url, pid } = result.json as { status: string; url: string; pid: number };
      pids.push(pid);
      expect(status).toBe("waiting");
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
      expect((await request(url)).status).toBe(200);
      const reply = await request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: "value=sw_live_123" });
      expect(reply.text).toContain("Done, you can close this tab.");
      await expect(getSecret("skillswiki", { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir })).resolves.toBe("sw_live_123");
      await waitForExit(pid);
    });

    it("refuses an id that is not a secret id, exit 2, and starts no page", () => {
      const result = runCli(["secret", "Skills Wiki"], {});
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Secret id 'Skills Wiki' must be lowercase letters, digits and dashes" });
    });
  });
  describe("installer mcp-headers (D52)", () => {
    it("prints exactly the Authorization header line from the keychain", async () => {
      const result = runCli(["mcp-headers", "skillswiki"], { env: await keychainEnv("sw_live_123") });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe('{"Authorization":"Bearer sw_live_123"}\n');
    });

    it("prints nothing and exits 1 when the key is missing", async () => {
      const result = runCli(["mcp-headers", "skillswiki"], { env: await keychainEnv() });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });
  });
  describe("installer disconnect", () => {
    it("deletes the key even when this home has no install, and reports it", async () => {
      const env = await keychainEnv("k-1");
      expect(runCli(["disconnect", "skillswiki"], { home: await makeTempHome(), env }).json).toEqual({ status: "disconnected", unregistered: false, secret_deleted: true });
      await expect(getSecret("skillswiki", { INSTALLER_KEYCHAIN: "file", ...env })).resolves.toBeNull();
    });

    it("removes the agent's Skills Wiki registration even from a home with no install (review finding 2a)", async () => {
      const agentHome = await makeTempHome();
      const fake = resolve("tests/fakes/fake-agent.mjs");
      spawnSync(process.execPath, [fake, "mcp", "add-json", "-s", "user", "skillswiki", '{"type":"http","url":"https://wiki.test/mcp"}'], { env: { ...process.env, FAKE_AGENT_HOME: agentHome } });
      await expect(access(join(agentHome, "mcp", "skillswiki.json"))).resolves.toBeUndefined();
      const env = { ...(await keychainEnv("k-1")), FAKE_AGENT_HOME: agentHome };
      expect(runCli(["disconnect", "skillswiki"], { home: await makeTempHome(), env }).json).toEqual({ status: "disconnected", unregistered: true, secret_deleted: true });
      await expect(access(join(agentHome, "mcp", "skillswiki.json"))).rejects.toThrow();
    });

    it("still deletes the key when the recorded agent profile cannot be loaded (review finding 2b)", async () => {
      const home = await makeTempHome();
      const runtime = { profile: "ghost", agent_version: null, c2_shell: true, c4_headless: false, c4_schema: false, c5_resume: false, c6_mcp: "not_probed", support_level: 0, tier: "unknown", notes: [] };
      await mkdir(join(home, "state"), { recursive: true });
      await writeFile(statePath(home), JSON.stringify({ schema: 1, solution: { ref: "file:/s.json", id: "s", version: "1" }, started_at: "2026-01-01T00:00:00.000Z", steps: {}, runtime }), "utf8");
      const env = await keychainEnv("k-1");
      const result = runCli(["disconnect", "skillswiki"], { home, env });
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({ status: "disconnected", unregistered: false, secret_deleted: true });
      await expect(getSecret("skillswiki", { INSTALLER_KEYCHAIN: "file", ...env })).resolves.toBeNull();
    });

    it("only knows skillswiki in this version, exit 2", async () => {
      const result = runCli(["disconnect", "gmail"], { home: await makeTempHome() });
      expect(result.code).toBe(2);
      expect(result.json).toMatchObject({ error: "Only 'skillswiki' can be disconnected in this version" });
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
