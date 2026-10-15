import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { parseProfile, type RuntimeProfile } from "../../src/core/profile.js";
import { loadState, saveState } from "../../src/core/state.js";
import { checkLocalSkills, frontmatter, inventory, localSkillText, localSkills, skillRoots, skillsBlock, skillswikiSkills, SKILL_TEXT_LIMIT, USER_SKILLS_ENV } from "../../src/core/skills.js";
import { runnerHome } from "../helpers/runner-home.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";

const servers: FakeMcp[] = [];
afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
});

const temp = (): Promise<string> => mkdtemp(join(tmpdir(), "skills-test-"));

async function skill(root: string, name: string, head: string, body = "The body sentence that must never be listed.", references: Record<string, string> = {}): Promise<string> {
  const folder = join(root, name);
  await mkdir(join(folder, "references"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), `${head}\n${body}\n`);
  for (const [file, text] of Object.entries(references)) await writeFile(join(folder, "references", file), text);
  return folder;
}

const PROFILE_BASE = {
  id: "p", name: "P", min_version: "1.0.0", detect: { cmd: ["p", "--version"], match: "P" },
  headless: { cmd: ["p", "-p", "{prompt}"], result_path: "result", session_path: "session_id" }, tos_review: { status: "ok", note: "test" },
};
const profile = (extra: Record<string, unknown> = {}): RuntimeProfile => parseProfile({ ...PROFILE_BASE, skills_dirs: { project: ".claude/skills", user: "~/.claude/skills" }, instructions_file: "CLAUDE.md", ...extra }, "/x");

describe("skills: frontmatter", () => {
  it("reads unquoted, quoted and folded values", () => {
    expect(frontmatter("---\nname: inbox\ndescription: Use for mail.\n---\nbody")).toEqual({ name: "inbox", description: "Use for mail." });
    expect(frontmatter("---\nname: \"inbox\"\ndescription: 'Use: for mail.'\n---\n")).toEqual({ name: "inbox", description: "Use: for mail." });
    expect(frontmatter("---\nname: inbox\ndescription: >\n  Use for mail\n  every morning.\n---\n")).toEqual({ name: "inbox", description: "Use for mail every morning." });
  });

  it("gives nothing without a frontmatter block", () => {
    expect(frontmatter("# Just a title\n")).toEqual({});
  });
});

describe("skills: the inventory of local folders", () => {
  it("lists names and descriptions only, never a skill's body", async () => {
    const root = await temp();
    await skill(root, "inbox-triage", "---\nname: inbox-triage\ndescription: Sort the morning mail.\n---");
    await skill(root, "no-front", "# No frontmatter");
    await mkdir(join(root, "not-a-skill"));
    const listed = await localSkills(root, "install folder");
    expect(listed).toEqual([
      { source: "install folder", name: "inbox-triage", description: "Sort the morning mail.", ref: join(root, "inbox-triage") },
      { source: "install folder", name: "no-front", description: "", ref: join(root, "no-front") },
    ]);
    expect(JSON.stringify(listed)).not.toContain("must never be listed");
  });

  it("gives an empty list for a folder that does not exist", async () => {
    expect(await localSkills(join(await temp(), "missing"), "your own")).toEqual([]);
  });
});

describe("skills: the agent's skill folders", () => {
  it("joins the project folder to the install folder and takes the user folder from the environment in tests", () => {
    expect(skillRoots(profile(), "/work/folder", { [USER_SKILLS_ENV]: "/tmp/user-skills" })).toEqual({ project: "/work/folder/.claude/skills", user: "/tmp/user-skills" });
  });

  it("expands ~ in the user folder", () => {
    expect(skillRoots(profile(), "/work", {}).user).toBe(join(homedir(), ".claude", "skills"));
  });

  it("has no project folder when started from the home folder, so nothing is written there", () => {
    const roots = skillRoots(profile(), homedir(), {});
    expect(roots.project).toBeUndefined();
    expect(roots.home_folder).toBe(true);
  });

  it("has no folders for an agent whose profile names none", () => {
    expect(skillRoots(parseProfile(PROFILE_BASE, "/x"), "/work", {})).toEqual({});
  });

  it.each([{ project: "/abs/skills" }, { project: "../skills" }, { project: "a/../../b" }])("refuses a profile whose project skills folder is %o", (dirs) => {
    expect(() => profile({ skills_dirs: dirs })).toThrow(/skills_dirs.project/);
  });

  it("refuses an instructions file that is a path", () => {
    expect(() => profile({ instructions_file: "../CLAUDE.md" })).toThrow(/instructions_file/);
  });
});

describe("skills: checking references and reading a skill's text", () => {
  async function roots() {
    const base = await temp();
    const project = join(base, "install", ".claude", "skills");
    const user = join(base, "user-skills");
    await mkdir(project, { recursive: true });
    await mkdir(user, { recursive: true });
    return { base, project, user };
  }

  it("accepts a project skill and a user skill", async () => {
    const r = await roots();
    const a = await skill(r.project, "a", "---\nname: a\n---");
    const b = await skill(r.user, "b", "---\nname: b\n---");
    await expect(checkLocalSkills([a, b], r)).resolves.toBeUndefined();
  });

  it("refuses a folder outside both skill folders", async () => {
    const r = await roots();
    const outside = await skill(r.base, "outside", "---\nname: outside\n---");
    await expect(checkLocalSkills([outside], r)).rejects.toThrow(/is not inside your agent's skills folders/);
  });

  it("refuses a link inside the project folder that points outside it", async () => {
    const r = await roots();
    const outside = await skill(r.base, "outside", "---\nname: outside\n---");
    await symlink(outside, join(r.project, "sneaky"));
    await expect(checkLocalSkills([join(r.project, "sneaky")], r)).rejects.toThrow(/is not inside your agent's skills folders/);
  });

  it("refuses a reference file that links outside the skill folder", async () => {
    const r = await roots();
    const folder = await skill(r.project, "a", "---\nname: a\n---");
    const secret = join(r.base, "secret.md");
    await writeFile(secret, "not for the prompt");
    await symlink(secret, join(folder, "references", "leak.md"));
    await expect(localSkillText(folder, r)).rejects.toThrow(/outside the skill folder/);
  });

  it("refuses a folder without SKILL.md and a relative path", async () => {
    const r = await roots();
    await mkdir(join(r.project, "empty"));
    await expect(checkLocalSkills([join(r.project, "empty")], r)).rejects.toThrow(/has no SKILL.md/);
    await expect(checkLocalSkills(["relative/skill"], r)).rejects.toThrow(InputError);
  });

  it("refuses skills that together pass the size limit, naming both sizes", async () => {
    const r = await roots();
    const half = "x".repeat(SKILL_TEXT_LIMIT / 2 + 100);
    const a = await skill(r.project, "a", "---\nname: a\n---", half);
    const b = await skill(r.project, "b", "---\nname: b\n---", half);
    await expect(checkLocalSkills([a], r)).resolves.toBeUndefined();
    await expect(checkLocalSkills([a, b], r)).rejects.toThrow(/come to \d+ KB together; the limit is 64 KB/);
  });

  it("reads SKILL.md, then each reference file by name", async () => {
    const r = await roots();
    const folder = await skill(r.project, "a", "---\nname: a\n---", "Do the work.", { "z-notes.md": "Zed.", "my-rules.md": "Flag repairs." });
    const text = await localSkillText(folder, r);
    expect(text.indexOf("Do the work.")).toBeLessThan(text.indexOf("### references/my-rules.md"));
    expect(text.indexOf("Flag repairs.")).toBeLessThan(text.indexOf("### references/z-notes.md"));
  });
});

describe("skills: the block a run's prompt gets", () => {
  it("is null without skills, and names each skill with the rule that the task's rules win", () => {
    expect(skillsBlock([])).toBeNull();
    const block = skillsBlock([{ ref: "/s/a", text: "Do A." }, { ref: "skillswiki:p/s/SKILL.md", text: "Do B." }]) ?? "";
    expect(block).toMatch(/^The owner's skills for this workflow\./);
    expect(block).toContain("always win over a skill");
    expect(block).toContain("--- skill: /s/a ---\nDo A.\n--- end of skill ---");
    expect(block).toContain("--- skill: skillswiki:p/s/SKILL.md ---\nDo B.\n--- end of skill ---");
  });
});

describe("skills: Skills Wiki's active skills", () => {
  it("lists each active pack's skills with skillswiki references, and names a pack whose list failed", async () => {
    const fake = await startFakeMcp({ FAKE_MCP_LIST_FAIL: "broken" });
    servers.push(fake);
    const { skills, notes } = await skillswikiSkills({ url: fake.url, key: fake.key });
    expect(skills).toEqual([{ source: "Skills Wiki", name: "demo/install", description: "Install the demo.", ref: "skillswiki:demo/install/SKILL.md" }]);
    expect(notes.join(" ")).toContain("broken");
    expect(notes.join(" ")).toContain("seo_geo");
  });
});

describe("skills: the inventory of an install", () => {
  async function install(workDir: string) {
    const home = await runnerHome();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: workDir });
    return home;
  }

  it("lists the install folder's skills, then the person's own, with no Skills Wiki when not connected", async () => {
    const work = await temp();
    const user = await temp();
    await skill(join(work, ".claude", "skills"), "inbox-triage", "---\nname: inbox-triage\ndescription: Sort mail.\n---");
    await skill(user, "humanizer", "---\nname: humanizer\ndescription: Plain words.\n---");
    const listed = await inventory(await install(work), { [USER_SKILLS_ENV]: user });
    expect(listed.skills.map((entry) => [entry.source, entry.name])).toEqual([["install folder", "inbox-triage"], ["your own", "humanizer"]]);
    expect(listed.notes).toEqual([]);
  });

  it("says so when TaskFollow was started from the home folder", async () => {
    const listed = await inventory(await install(homedir()), { [USER_SKILLS_ENV]: await temp() });
    expect(listed.notes.join(" ")).toContain("started from your home folder");
  });

  it("lists Skills Wiki's active skills when it is connected", async () => {
    const fake = await startFakeMcp();
    servers.push(fake);
    const home = await install(await temp());
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: fake.url } });
    const { setSecret } = await import("../../src/core/keychain.js");
    await setSecret("skillswiki", fake.key);
    const listed = await inventory(home, { ...process.env, [USER_SKILLS_ENV]: await temp() });
    expect(listed.skills.map((entry) => entry.ref)).toContain("skillswiki:demo/install/SKILL.md");
  });
});
