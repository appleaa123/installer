import { chmod, lstat, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSection, removeSection, restoreFile, SECTION_BEGIN, SECTION_END, sectionText, writeSection } from "../../src/core/agent-file.js";
import { InputError } from "../../src/core/inputs.js";

/** 9.12 item 2: TaskFollow keeps one marked section in CLAUDE.md and leaves every other byte of the file alone. */
const folder = (): Promise<string> => mkdtemp(join(tmpdir(), "agent-file-"));
const OWNER = "# My notes\n\nAlways answer in French.\n";

describe("agent file: the section's text", () => {
  it("lists each workflow with its skills, local ones by name and path inside the install folder", () => {
    const text = sectionText([{ workflow: "inbox", description: "Sort the\nmorning mail.", skills: ["/w/.claude/skills/inbox", "/elsewhere/skills/tone", "skillswiki:p/s/SKILL.md"] }], "/w");
    expect(text).toContain("## TaskFollow workflows");
    expect(text).toContain("Always ask the owner before sending anything to a customer, paying, anything legal, or deleting.");
    expect(text).toContain("- **inbox**: Sort the morning mail. Skills: inbox (`.claude/skills/inbox`), tone (`/elsewhere/skills/tone`), skillswiki:p/s/SKILL.md");
  });

  it("shortens a long description and says when there are no workflows", () => {
    expect(sectionText([{ workflow: "w", description: "x".repeat(300), skills: [] }], "/w")).toContain(`- **w**: ${"x".repeat(199)}…`);
    expect(sectionText([], "/w")).toContain("No workflows yet.");
  });
});

describe("agent file: writing and removing the section", () => {
  it("creates the file with only the section when there is none", async () => {
    const file = join(await folder(), "CLAUDE.md");
    expect(await writeSection(file, "BODY")).toEqual({ created: true });
    expect(await readFile(file, "utf8")).toBe(`${SECTION_BEGIN}\nBODY\n${SECTION_END}\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it("appends to the owner's file and replaces only its own lines afterwards", async () => {
    const file = join(await folder(), "CLAUDE.md");
    await writeFile(file, OWNER);
    await chmod(file, 0o600);
    expect(await writeSection(file, "FIRST")).toEqual({ created: false });
    const once = await readFile(file, "utf8");
    expect(once.startsWith(OWNER)).toBe(true);
    await writeFile(file, `${once}\n## The owner's own section below\n`);
    await writeSection(file, "SECOND");
    const twice = await readFile(file, "utf8");
    expect(twice).toBe(`${OWNER}\n${SECTION_BEGIN}\nSECOND\n${SECTION_END}\n\n## The owner's own section below\n`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("keeps Windows line endings", async () => {
    const file = join(await folder(), "CLAUDE.md");
    await writeFile(file, "# Notes\r\nKeep it.\r\n");
    await writeSection(file, "BODY");
    expect(await readFile(file, "utf8")).toBe(`# Notes\r\nKeep it.\r\n\r\n${SECTION_BEGIN}\r\nBODY\r\n${SECTION_END}\r\n`);
  });

  it.each([`${SECTION_BEGIN}\nopen`, `${SECTION_BEGIN}\nx\n${SECTION_END}\n${SECTION_BEGIN}\ny\n${SECTION_END}\n`, `${SECTION_END}\n${SECTION_BEGIN}\n`])("refuses a file whose section is broken, and leaves it as it was: %j", async (broken) => {
    const file = join(await folder(), "CLAUDE.md");
    await writeFile(file, broken);
    await expect(readSection(file)).rejects.toThrow(InputError);
    await expect(writeSection(file, "BODY")).rejects.toThrow("not closed");
    expect(await readFile(file, "utf8")).toBe(broken);
  });

  it("removes the section and gives the owner's file back byte for byte", async () => {
    const file = join(await folder(), "CLAUDE.md");
    await writeFile(file, OWNER);
    await writeSection(file, "BODY");
    expect(await removeSection(file, false)).toBe("removed");
    expect(await readFile(file, "utf8")).toBe(OWNER);
    expect(await removeSection(file, false)).toBe("absent");
  });

  it("deletes a file TaskFollow created once only the section was in it", async () => {
    const dir = await folder();
    const file = join(dir, "CLAUDE.md");
    await writeSection(file, "BODY");
    expect(await removeSection(file, true)).toBe("deleted");
    await expect(readFile(file, "utf8")).rejects.toThrow();
    expect(await removeSection(file, true)).toBe("absent");
  });

  it("keeps a file TaskFollow created when the owner has written in it since", async () => {
    const file = join(await folder(), "CLAUDE.md");
    await writeSection(file, "BODY");
    await writeFile(file, `${await readFile(file, "utf8")}\nMy own line.\n`);
    expect(await removeSection(file, true)).toBe("removed");
    expect(await readFile(file, "utf8")).toBe("My own line.\n");
  });

  it("puts a file back to what was read before a failed change, or removes one that did not exist", async () => {
    const dir = await folder();
    const file = join(dir, "CLAUDE.md");
    await writeFile(file, OWNER);
    const before = await readSection(file);
    await writeSection(file, "BODY");
    await restoreFile(file, before);
    expect(await readFile(file, "utf8")).toBe(OWNER);
    const fresh = join(dir, "AGENTS.md");
    const none = await readSection(fresh);
    await writeSection(fresh, "BODY");
    await restoreFile(fresh, none);
    await expect(readFile(fresh, "utf8")).rejects.toThrow();
  });

  it("refuses a file it cannot read, and never replaces it (review finding 1)", async () => {
    const file = join(await folder(), "CLAUDE.md");
    await writeFile(file, "# The owner's notes\n");
    await chmod(file, 0o000);
    try {
      await expect(readSection(file)).rejects.toThrow("cannot be read");
      await expect(writeSection(file, "BODY")).rejects.toThrow("cannot be read");
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, "utf8")).toBe("# The owner's notes\n");
  });

  it("writes through a linked CLAUDE.md into the file it points to, and keeps the link (review finding 2)", async () => {
    const dir = await folder();
    await writeFile(join(dir, "AGENTS.md"), "# Shared\n");
    await symlink("AGENTS.md", join(dir, "CLAUDE.md"));
    await writeSection(join(dir, "CLAUDE.md"), "BODY");
    expect((await lstat(join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("BODY");
    expect(await removeSection(join(dir, "CLAUDE.md"), false)).toBe("removed");
    expect((await lstat(join(dir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe("# Shared\n");
  });

  it("refuses a link that points to nothing", async () => {
    const dir = await folder();
    await symlink("missing.md", join(dir, "CLAUDE.md"));
    await expect(writeSection(join(dir, "CLAUDE.md"), "BODY")).rejects.toThrow("points to a file that does not exist");
  });

  it("leaves no temporary file behind when the write fails", async () => {
    const dir = await folder();
    await writeFile(join(dir, "CLAUDE.md"), "# Mine\n");
    await chmod(dir, 0o500);
    try {
      await expect(writeSection(join(dir, "CLAUDE.md"), "BODY")).rejects.toThrow();
    } finally {
      await chmod(dir, 0o700);
    }
    expect(await readdir(dir)).toEqual(["CLAUDE.md"]);
  });
});

