import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { writeConfig } from "../../src/core/data-source.js";
import { DOCTOR_CHECKS, type DoctorContext } from "../../src/core/doctor-checks.js";
import { INSTALL_ENV, LOCAL_FILE, SKILLSWIKI_SOURCE, installLocalSkillswiki, libraryRoot, readLocalSkillswiki, removeLocalSkillswiki } from "../../src/core/skillswiki-local.js";
import { localSkillText, localSkills, skillRoots } from "../../src/core/skills.js";
import type { InstallState } from "../../src/core/types.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** D178: TaskFollow installs local Skills Wiki with pipx and runs its setup; here python, pipx and skillswiki are fakes on a PATH of their own. */
const MODULE = pathToFileURL(resolve("tests/fakes/fake-skillswiki.mjs")).href;
const wrapper = (role: string): string => `#!${process.execPath}\nprocess.env.FAKE_ROLE = ${JSON.stringify(role)};\nimport(${JSON.stringify(MODULE)});\n`;

interface Machine {
  readonly env: Record<string, string>;
  readonly home: string;
  readonly person: string;
  readonly bin: string;
  readonly log: () => Promise<{ role: string; args: string[]; cwd: string }[]>;
}

/** A person's machine: their home folder, a PATH holding only the commands named, and a fresh TaskFollow home. */
async function machine(commands: Record<string, string>, extra: Record<string, string> = {}): Promise<Machine> {
  const [home, person] = [await makeTempHome(), await makeTempHome()];
  const bin = join(person, "bin");
  await mkdir(bin);
  for (const [name, role] of Object.entries(commands)) {
    await writeFile(join(bin, name), wrapper(role));
    await chmod(join(bin, name), 0o755);
  }
  const logFile = join(person, "calls.jsonl");
  const env = { PATH: bin, HOME: person, FAKE_NODE: process.execPath, FAKE_MODULE: MODULE, FAKE_SW_BIN: bin, FAKE_SW_LOG: logFile, FAKE_SW_LIBRARY: join(person, ".skillswiki", "library"), ...extra };
  const log = async () => (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as { role: string; args: string[]; cwd: string });
  return { env, home, person, bin, log };
}

const READY = { "python3.11": "python:3.11", pipx: "pipx" };

describe("installing local Skills Wiki (D178)", () => {
  it("installs the pinned version with a new enough Python, sets it up from the person's home folder and keeps what it found", async () => {
    const box = await machine({ ...READY, python3: "python:3.9" });
    const result = await installLocalSkillswiki(box.home, box.env);
    const person = await realpath(box.person);
    expect(result).toEqual({ local: { version: "0.3.3", bin: join(box.bin, "skillswiki"), library: join(box.person, ".skillswiki", "library") }, moved: 1, backup: join(person, ".skillswiki/backups/setup-20261020-114754.zip") });
    const calls = await box.log();
    expect(calls.find((call) => call.role === "pipx")?.args).toEqual(["install", "--python", join(box.bin, "python3.11"), SKILLSWIKI_SOURCE]);
    const setup = calls.find((call) => call.role === "skillswiki" && call.args.includes("setup"));
    expect(setup).toMatchObject({ args: ["--json", "setup"] });
    expect(await realpath(setup?.cwd ?? "")).toBe(person);
    expect(await readLocalSkillswiki(box.home)).toEqual(result.local);
    expect(SKILLSWIKI_SOURCE).toBe("git+https://github.com/appleaa123/skills_wiki_opensource.git@v0.3.3");
  });

  it("does not install again when the pinned version already answers", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    expect((await box.log()).some((call) => call.role === "pipx")).toBe(false);
  });

  it("replaces another installed version with the pinned one", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" }, { FAKE_SW_VERSION: "0.2.0" });
    await installLocalSkillswiki(box.home, box.env).catch(() => undefined);
    expect((await box.log()).find((call) => call.role === "pipx")?.args.slice(0, 2)).toEqual(["install", "--force"]);
  });

  it.each([
    ["no Python at all", { pipx: "pipx" }],
    ["only a Python older than 3.11", { python3: "python:3.10", pipx: "pipx" }],
    ["no pipx", { "python3.12": "python:3.12" }],
  ])("stops with the plain fix when there is %s, and moves nothing", async (_name, commands) => {
    const box = await machine(commands);
    await expect(installLocalSkillswiki(box.home, box.env)).rejects.toThrow("needs Python 3.11 or newer and pipx");
    expect((await box.log()).some((call) => call.args.includes("setup"))).toBe(false);
    expect(await readLocalSkillswiki(box.home)).toBeNull();
  });

  it("says what pipx printed when the install fails", async () => {
    const box = await machine(READY, { FAKE_PIPX_FAIL: "1" });
    await expect(installLocalSkillswiki(box.home, box.env)).rejects.toThrow("pipx could not install Skills Wiki: pip failed to build package:     cryptography Fatal error from pip prevented installation.");
  });

  it("moves nothing when the installed command is not on the PATH the agents use", async () => {
    const box = await machine(READY, { FAKE_SW_BIN: await makeTempHome() });
    await expect(installLocalSkillswiki(box.home, box.env)).rejects.toThrow("pipx ensurepath");
    expect((await box.log()).some((call) => call.args.includes("setup"))).toBe(false);
  });

  it.each([
    ["stopped", "stopped before it finished"],
    ["failed", "could not move these skills: big-skill"],
  ])("fails when setup %s, though it exited 0", async (mode, message) => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" }, { FAKE_SW_SETUP: mode });
    await expect(installLocalSkillswiki(box.home, box.env)).rejects.toThrow(message);
    expect(await readLocalSkillswiki(box.home)).toBeNull();
  });

  it("fails, keeping nothing, when Skills Wiki does not answer its doctor after setup", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    const broken = { ...box.env, FAKE_SW_DOCTOR: "broken" };
    const home = await makeTempHome();
    await expect(installLocalSkillswiki(home, broken)).rejects.toThrow(ActionFailure);
    await expect(installLocalSkillswiki(home, broken)).rejects.toThrow("does not answer 'skillswiki doctor'");
    expect(await readLocalSkillswiki(home)).toBeNull();
  });

  it("never runs in a test run", async () => {
    const box = await machine(READY, { [INSTALL_ENV]: "none" });
    await expect(installLocalSkillswiki(box.home, box.env)).rejects.toThrow("not installed in this run");
    expect(await box.log()).toEqual([]);
    expect(process.env[INSTALL_ENV]).toBe("none");
  });
});

describe("the Skills Wiki library as a skill folder TaskFollow reads (D178)", () => {
  const AT = "2026-10-20T12:00:00.000Z";
  const withAnswer = (value: string): InstallState => ({ schema: 1, solution: { ref: "file:starter.json", id: "starter", version: "2.4.0" }, started_at: AT, steps: { "services.skills": { status: "done", at: AT, by: "human", value } } });

  async function library(): Promise<{ home: string; root: string }> {
    const [home, root] = [await makeTempHome(), await makeTempHome()];
    await mkdir(join(root, "check-word"));
    await writeFile(join(root, "check-word", "SKILL.md"), "---\nname: check-word\ndescription: Use when asked for the check word.\n---\n\nAnswer with exactly: PELICAN-1\n");
    await writeConfig(home, LOCAL_FILE, { version: "0.3.3", bin: "/x/skillswiki", library: root });
    return { home, root };
  }

  it("is read only when the person chose local Skills Wiki", async () => {
    const { home, root } = await library();
    expect(await libraryRoot(home, withAnswer("skills"))).toBe(root);
    expect(await libraryRoot(home, withAnswer("none"))).toBeUndefined();
    expect(await libraryRoot(await makeTempHome(), withAnswer("skills"))).toBeUndefined();
  });

  it("leaves the roots as they were without it", () => {
    expect(skillRoots(undefined, "/work", {})).toEqual({ project: "/work/.agents/skills" });
    expect(skillRoots(undefined, "/work", {}, "/lib")).toEqual({ project: "/work/.agents/skills", library: "/lib" });
  });

  it("lists its skills and gives a run their text", async () => {
    const { root } = await library();
    expect(await localSkills(root, "Skills Wiki (local)")).toEqual([{ source: "Skills Wiki (local)", name: "check-word", description: "Use when asked for the check word.", ref: join(root, "check-word") }]);
    expect(await localSkillText(join(root, "check-word"), { library: root })).toContain("PELICAN-1");
  });

  it("finds a skill Skills Wiki moved after the workflow named its old folder", async () => {
    const { root } = await library();
    const user = await makeTempHome();
    expect(await localSkillText(join(user, "check-word"), { user, library: root })).toContain("PELICAN-1");
    await expect(localSkillText(join(user, "check-word"), { user })).rejects.toThrow("does not exist");
  });

  it("still refuses a folder outside every skill folder", async () => {
    const { root } = await library();
    const elsewhere = await makeTempHome();
    await mkdir(join(elsewhere, "stray"));
    await writeFile(join(elsewhere, "stray", "SKILL.md"), "---\nname: stray\n---\n");
    await expect(localSkillText(join(elsewhere, "stray"), { library: root })).rejects.toThrow("is not inside your agent's skills folders");
  });
});

describe("the doctor on local Skills Wiki (D178)", () => {
  const AT = "2026-10-20T12:00:00.000Z";
  const chosen: InstallState = { schema: 1, solution: { ref: "file:starter.json", id: "starter", version: "2.4.0" }, started_at: AT, steps: { "services.skills": { status: "done", at: AT, by: "human", value: "skills" } } };
  const check = DOCTOR_CHECKS.find((entry) => entry.id === "skills_local");
  const run = (home: string, state: InstallState | null, env: Record<string, string>) => check?.run({ home, state, now: AT, env, freeBytes: async () => 0, host: null, shadow: false } as DoctorContext);

  it("says nothing when local Skills Wiki was not chosen", async () => {
    expect(await run(await makeTempHome(), null, {})).toBeNull();
  });

  it("warns while it was chosen but is not installed yet", async () => {
    expect(await run(await makeTempHome(), chosen, {})).toMatchObject({ status: "warn", fix: "taskfollow resume" });
  });

  it("is ok when the recorded command answers with the pinned version, whatever the PATH", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    expect(await run(box.home, chosen, { ...box.env, PATH: "" })).toMatchObject({ status: "ok", detail: expect.stringContaining("Skills Wiki 0.3.3") });
  });

  it("warns when the install's own agent is not connected to Skills Wiki's MCP server", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    const withAgent: InstallState = { ...chosen, runtime: { profile: "claude-code" } as InstallState["runtime"] };
    expect(await run(box.home, withAgent, { ...box.env, FAKE_SW_MCP: "none" })).toMatchObject({ status: "warn", detail: expect.stringContaining("not connected to Skills Wiki's MCP server") });
    expect(await run(box.home, withAgent, box.env)).toMatchObject({ status: "ok" });
  });

  it("warns on another version and fails when it does not answer, naming the pipx command", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    expect(await run(box.home, chosen, { ...box.env, FAKE_SW_VERSION: "0.4.0" })).toMatchObject({ status: "warn", fix: expect.stringContaining(`pipx install --force ${SKILLSWIKI_SOURCE}`) });
    expect(await run(box.home, chosen, { ...box.env, FAKE_SW_DOCTOR: "broken" })).toMatchObject({ status: "fail" });
  });
});

describe("removing local Skills Wiki at uninstall (D178)", () => {
  it("puts the skills back first, then removes the program with pipx", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    expect(await removeLocalSkillswiki(box.home, box.env)).toEqual({ status: "removed" });
    const calls = (await box.log()).map((call) => `${call.role} ${call.args.join(" ")}`);
    expect(calls.slice(-2)).toEqual(["skillswiki --json uninstall --yes", "pipx uninstall skillswiki"]);
  });

  it("keeps the program when a skill could not go back, and says how to see what is left", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    const result = await removeLocalSkillswiki(box.home, { ...box.env, FAKE_SW_UNINSTALL: "blocked" });
    expect(result).toMatchObject({ status: "kept", detail: expect.stringContaining("run 'skillswiki uninstall'") });
    expect((await box.log()).some((call) => call.role === "pipx" && call.args[0] === "uninstall")).toBe(false);
  });

  it("passes on what Skills Wiki could not undo itself, for the person to run", async () => {
    const box = await machine({ ...READY, skillswiki: "skillswiki" });
    await installLocalSkillswiki(box.home, box.env);
    expect(await removeLocalSkillswiki(box.home, { ...box.env, FAKE_SW_UNINSTALL: "self_setup" })).toEqual({ status: "removed", left: ["Run: claude mcp remove skillswiki --scope user"] });
  });

  it("has nothing to remove when it was never installed", async () => {
    expect(await removeLocalSkillswiki(await makeTempHome(), {})).toEqual({ status: "not_installed" });
  });
});
