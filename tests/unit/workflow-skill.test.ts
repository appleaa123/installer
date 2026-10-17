import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SECTION_BEGIN } from "../../src/core/agent-file.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import { loadWritten, refreshAgentFile } from "../../src/core/workflow-skill.js";
import { workflowIds } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

/** 9.12 item 2: workflow add writes the workflow's own skill folder and the CLAUDE.md section, all or nothing. */
const AT = "2026-10-15T12:00:00.000Z";
const SOLUTION = { id: "fixture-skills", version: "1.0.0", workflows: [], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
afterEach(() => vi.restoreAllMocks());

async function install(): Promise<{ home: string; work: string }> {
  const home = await runnerHome();
  const work = await mkdtemp(join(tmpdir(), "install-folder-"));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  await writePinnedSolution(home, JSON.stringify(SOLUTION));
  return { home, work };
}
const add = (home: string, id: string, words: Record<string, unknown>) => workflowCommand(home, "add", id, JSON.stringify({ tools: ["memo.list"], ...words }), () => AT);
const skillsDir = (work: string) => join(work, ".claude", "skills");

describe("workflow add: the workflow's own skill (9.12 item 2)", () => {
  it("writes SKILL.md and my-rules.md, names the folder first in the workflow, and lists it in CLAUDE.md", async () => {
    const { home, work } = await install();
    const result = await add(home, "inbox", { description: "Sort the morning mail.", my_rules: "Flag every repair request." });
    const folder = join(skillsDir(work), "inbox");
    expect(result).toMatchObject({ status: "added", skill_folder: folder, agent_file: join(work, "CLAUDE.md"), skills: [folder] });
    const skill = await readFile(join(folder, "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: inbox\ndescription: Use for the owner's "inbox" work, which TaskFollow also runs as a workflow: Sort the morning mail\./);
    expect(skill).toContain("Read `references/my-rules.md` first.");
    expect(skill).toContain("Before sending anything to a customer, paying or committing money, anything legal, and deleting anything, ask the owner");
    expect(await readFile(join(folder, "references", "my-rules.md"), "utf8")).toBe("# My rules for inbox\n\nFlag every repair request.\n");
    const section = await readFile(join(work, "CLAUDE.md"), "utf8");
    expect(section).toContain("- **inbox**: Sort the morning mail. Skills: inbox (`.claude/skills/inbox`)");
    expect(await loadWritten(home)).toEqual({ skill_folders: [{ workflow: "inbox", path: folder, root: skillsDir(work) }], agent_file: { path: join(work, "CLAUDE.md"), created: true } });
  });

  it("writes a placeholder when the person gave no rules yet", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    expect(await readFile(join(skillsDir(work), "inbox", "references", "my-rules.md"), "utf8")).toContain("None yet.");
  });

  it("lists every workflow in the section and keeps the owner's own text", async () => {
    const { home, work } = await install();
    await writeFile(join(work, "CLAUDE.md"), "# Mine\n\nKeep this.\n");
    await add(home, "inbox", { description: "Sort mail." });
    await add(home, "leads", { description: "Qualify leads." });
    const text = await readFile(join(work, "CLAUDE.md"), "utf8");
    expect(text.startsWith("# Mine\n\nKeep this.\n\n")).toBe(true);
    expect(text).toContain("- **inbox**");
    expect(text).toContain("- **leads**");
    expect((await loadWritten(home)).agent_file).toEqual({ path: join(work, "CLAUDE.md"), created: false });
  });

  it("never overwrites a skill folder the agent already has", async () => {
    const { home, work } = await install();
    await mkdir(join(skillsDir(work), "inbox"), { recursive: true });
    await writeFile(join(skillsDir(work), "inbox", "SKILL.md"), "the owner's own");
    await expect(add(home, "inbox", { description: "Sort mail." })).rejects.toThrow("Your agent already has a skill folder named 'inbox'");
    expect(await readFile(join(skillsDir(work), "inbox", "SKILL.md"), "utf8")).toBe("the owner's own");
    expect(await workflowIds(home)).toEqual([]);
  });

  it("refuses before writing anything when CLAUDE.md has a broken section", async () => {
    const { home, work } = await install();
    await writeFile(join(work, "CLAUDE.md"), `${SECTION_BEGIN}\nopen`);
    await expect(add(home, "inbox", { description: "Sort mail." })).rejects.toThrow("not closed");
    await expect(readdir(skillsDir(work))).rejects.toThrow();
    expect(await workflowIds(home)).toEqual([]);
  });

  it("leaves nothing behind when writing the workflow fails part way", async () => {
    const { home, work } = await install();
    await writeFile(join(work, "CLAUDE.md"), "# Mine\n");
    await mkdir(join(home, "workflows"), { recursive: true });
    await chmod(join(home, "workflows"), 0o500);
    try {
      await expect(add(home, "inbox", { description: "Sort mail." })).rejects.toThrow();
    } finally {
      await chmod(join(home, "workflows"), 0o700);
    }
    await expect(readdir(join(skillsDir(work), "inbox"))).rejects.toThrow();
    expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toBe("# Mine\n");
    expect(await loadWritten(home)).toEqual({ skill_folders: [] });
  });

  it("writes nothing into a home folder install, and says why", async () => {
    const { home } = await install();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: (await import("node:os")).homedir() });
    const result = await add(home, "inbox", { description: "Sort mail." });
    expect(result).toMatchObject({ status: "added", skill_folder: null, agent_file: null, note: expect.stringContaining("home folder") });
    await expect(add(home, "leads", { description: "Leads.", my_rules: "x" })).rejects.toThrow("home folder");
  });

  it("refreshes the section from the workflows on disk", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await writeFile(join(work, "CLAUDE.md"), "# Mine\n");
    expect(await refreshAgentFile(home)).toBe(join(work, "CLAUDE.md"));
    expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toContain("- **inbox**");
  });

  it("says in plain words when the skill folder cannot be written (review finding 4)", async () => {
    const { home, work } = await install();
    await mkdir(join(work, ".claude"), { recursive: true });
    await chmod(join(work, ".claude"), 0o500);
    try {
      await expect(add(home, "inbox", { description: "Sort mail." })).rejects.toThrow(`TaskFollow could not write the workflow's files (${join(skillsDir(work), "inbox")}`);
    } finally {
      await chmod(join(work, ".claude"), 0o700);
    }
    expect(await workflowIds(home)).toEqual([]);
  });

  it("names the real gap when the install folder is not known", async () => {
    const { home } = await install();
    const state = await loadState(home);
    if (state) {
      const { work_dir: _gone, ...rest } = state;
      await saveState(home, rest);
    }
    expect(await add(home, "inbox", { description: "Sort mail." })).toMatchObject({ skill_folder: null, note: expect.stringContaining("does not know which folder") });
  });
});


describe("workflow add: the shipped skill of a shape (item 5)", () => {
  const TRIAGE = {
    workflow: "inbox-triage", description: "Every morning, the mail since you last did this (or in the last 24 hours): what needs me.", mode: "typed", trigger: { manual: true },
    steps: [{ id: "mail", tool: "channel.inbox", args: { after: "last-run" } }, { id: "triage", agent: { instructions: "Use the inbox-triage skill.", input: "${mail}", tools: ["memo.list"] } }],
  };
  async function shapeInstall(): Promise<{ home: string; work: string }> {
    const { home, work } = await install();
    await writePinnedSolution(home, JSON.stringify({ ...SOLUTION, workflows: [TRIAGE] }));
    return { home, work };
  }
  const shipped = (id: string) => readFile(join(process.cwd(), "solutions", "shapes", id, "SKILL.md"), "utf8");

  it("workflow add inbox-triage writes the shipped SKILL.md with the workflow id as name", async () => {
    const { home, work } = await shapeInstall();
    await workflowCommand(home, "add", "inbox-triage", undefined, () => AT);
    const skill = await readFile(join(skillsDir(work), "inbox-triage", "SKILL.md"), "utf8");
    expect(skill).toBe(await shipped("inbox-triage"));
    expect(skill).toMatch(/^---\nname: inbox-triage\n/);
  });

  it("workflow add inbox-triage keeps the person's my_rules in references/my-rules.md", async () => {
    const { home, work } = await shapeInstall();
    await workflowCommand(home, "add", "inbox-triage", JSON.stringify({ my_rules: "Repairs at 12 Oak St come first." }), () => AT);
    expect(await readFile(join(skillsDir(work), "inbox-triage", "references", "my-rules.md"), "utf8")).toContain("Repairs at 12 Oak St come first.");
  });

  it("workflow add writes references/examples.md, from the interview or None yet", async () => {
    const { home, work } = await shapeInstall();
    await workflowCommand(home, "add", "inbox-triage", JSON.stringify({ examples: "Tom asks for the lease copy: reply." }), () => AT);
    expect(await readFile(join(skillsDir(work), "inbox-triage", "references", "examples.md"), "utf8")).toBe("# Examples for inbox-triage\n\nTom asks for the lease copy: reply.\n");
    await add(home, "described", { description: "Sort the morning mail." });
    expect(await readFile(join(skillsDir(work), "described", "references", "examples.md"), "utf8")).toContain("None yet");
  });

  it("refuses examples that are not text", async () => {
    const { home } = await shapeInstall();
    await expect(workflowCommand(home, "add", "inbox-triage", JSON.stringify({ examples: ["x"] }), () => AT)).rejects.toThrow('"examples" must be text');
  });

  it("a described workflow still gets the generic SKILL.md", async () => {
    const { home, work } = await shapeInstall();
    await add(home, "inbox-triage", { description: "My own way of sorting mail." });
    const skill = await readFile(join(skillsDir(work), "inbox-triage", "SKILL.md"), "utf8");
    expect(skill).toContain("Use for the owner's \"inbox-triage\" work, which TaskFollow also runs as a workflow: My own way of sorting mail");
  });

  it.each(["inbox-triage", "inbox-triage-replies"])("shipped shape skills name no TaskFollow tool or command (%s)", async (id) => {
    const skill = await shipped(id);
    expect(skill).not.toMatch(/\bchannel\.[a-z]|\btaskfollow\s|mcp__/);
    expect(skill).toMatch(new RegExp(`^---\\nname: ${id}\\n`));
  });

  it.each(["inbox-triage", "inbox-triage-replies"])("shipped shape skills say since you last did this or the last 24 hours (%s)", async (id) => {
    expect(await shipped(id)).toContain("since you last did this (or in the last 24 hours");
  });

  it.each(["inbox-triage", "inbox-triage-replies"])("shipped shape skills say how many messages wait (%s)", async (id) => {
    expect(await shipped(id)).toContain("When the input says more messages wait, end the list with how many.");
  });

  it.each(["inbox-triage", "inbox-triage-replies"])("shipped shape skills keep the rules heading with the pointer on its own line (%s)", async (id) => {
    const lines = (await shipped(id)).split("\n");
    expect(lines).toContain("## The owner's own rules");
    expect(lines.filter((line) => line.includes("references/"))).toEqual(["Read `references/my-rules.md` first. The owner's rules there win over anything general here."]);
    expect((await shipped(id)).length).toBeLessThan(20000);
  });
});

describe("workflow rule: a rule the owner said yes to, into my-rules.md (item 8)", () => {
  const rule = (home: string, id: string, words: Record<string, unknown>) => workflowCommand(home, "rule", id, JSON.stringify(words), () => AT);
  const rulesOf = (work: string, id: string) => readFile(join(skillsDir(work), id, "references", "my-rules.md"), "utf8");

  it("appends one line and replaces the None yet line the first time", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const file = join(skillsDir(work), "inbox", "references", "my-rules.md");
    expect(await rule(home, "inbox", { rule: "Write replies in a short, friendly tone." })).toEqual({
      status: "added", workflow: "inbox", rule: "Write replies in a short, friendly tone.", file,
      next: `Tell the person exactly this rule, word for word: it applies from the next run and in chat now. To change or remove a rule, they edit ${file} themselves.`,
    });
    expect(await rulesOf(work, "inbox")).toBe("# My rules for inbox\n\n- Write replies in a short, friendly tone.\n");
  });

  it("appends a second rule below the first, and below the interview's own rules", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail.", my_rules: "Flag every repair request." });
    await rule(home, "inbox", { rule: "First names only." });
    await rule(home, "inbox", { rule: "Never promise a date." });
    expect(await rulesOf(work, "inbox")).toBe("# My rules for inbox\n\nFlag every repair request.\n- First names only.\n- Never promise a date.\n");
  });

  it("keeps a line someone else added to a None yet file", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const file = join(skillsDir(work), "inbox", "references", "my-rules.md");
    await writeFile(file, `${await readFile(file, "utf8")}- Theirs.\n`);
    await rule(home, "inbox", { rule: "Mine." });
    expect(await rulesOf(work, "inbox")).toBe("# My rules for inbox\n\n- Mine.\n- Theirs.\n");
  });

  it.each([
    ["Line one\nline two", "one line"],
    ["# A heading", "not starting with #"],
    ["Read references/my-rules.md again", "not naming references/my-rules.md"],
    ["x".repeat(601), "1 to 600 characters"],
    ["   ", "1 to 600 characters"],
  ])("refuses %j", async (text, message) => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await expect(rule(home, "inbox", { rule: text })).rejects.toThrow(message);
  });

  it.each([
    ["Keep copies in /Users/me/notes", "a path on this computer"],
    ["Then run taskfollow why", "a taskfollow command"],
  ])("refuses a rule checkDelivered refuses: %j", async (text, kind) => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await expect(rule(home, "inbox", { rule: text })).rejects.toThrow(`This rule holds ${kind}`);
    expect(await rulesOf(work, "inbox")).toContain("None yet.");
  });

  it("refuses a rules folder moved or linked out of the recorded root", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const away = await mkdtemp(join(tmpdir(), "away-"));
    const { rename, symlink } = await import("node:fs/promises");
    await rename(join(skillsDir(work), "inbox"), join(away, "inbox"));
    await symlink(join(away, "inbox"), join(skillsDir(work), "inbox"));
    await expect(rule(home, "inbox", { rule: "Mine." })).rejects.toThrow("TaskFollow did not write");
  });

  it("refuses a my-rules.md that is a link", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const file = join(skillsDir(work), "inbox", "references", "my-rules.md");
    const elsewhere = join(await mkdtemp(join(tmpdir(), "elsewhere-")), "rules.md");
    await writeFile(elsewhere, "# Not TaskFollow's\n");
    const { rm, symlink } = await import("node:fs/promises");
    await rm(file);
    await symlink(elsewhere, file);
    await expect(rule(home, "inbox", { rule: "Mine." })).rejects.toThrow("TaskFollow did not write");
    expect(await readFile(elsewhere, "utf8")).toBe("# Not TaskFollow's\n");
  });

  it("refuses a workflow whose agent has no skills folder TaskFollow wrote", async () => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const { saveWritten } = await import("../../src/core/workflow-skill.js");
    await saveWritten(home, { skill_folders: [] });
    await expect(rule(home, "inbox", { rule: "Mine." })).rejects.toThrow("Workflow 'inbox' has no rules file TaskFollow wrote (its agent has no skills folder TaskFollow knows), so there is nowhere to keep a rule: tell the person, and keep the rule in mind in chat");
  });

  it("with learning closes that candidate; a closed one is refused", async () => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const { requestApproval, rejectItem } = await import("../../src/core/approvals.js");
    const { prepareAgentCall } = await import("../../src/core/agent-call.js");
    const { collectRuleCandidates, listRuleCandidates } = await import("../../src/core/learning.js");
    const asked = await requestApproval(home, { prepared: prepareAgentCall("reply", "mcp__mail__send", { to: 1 }), via: "runner", run: { workflow: "inbox", run_id: "r1", step: "reply" }, why: "Reply" }, AT);
    await rejectItem(home, asked.id, { name: "Owner", role: "decision_maker" }, "too formal", AT);
    const [candidate] = await collectRuleCandidates(home, AT);
    await rule(home, "inbox", { rule: "Friendly tone.", learning: candidate?.id });
    expect(await listRuleCandidates(home)).toEqual([expect.objectContaining({ id: candidate?.id, status: "added", closed_at: AT })]);
    await expect(rule(home, "inbox", { rule: "Again.", learning: candidate?.id })).rejects.toThrow(`Rule candidate ${candidate?.id} is added already`);
  });

  it("audits the rule by fingerprint, never by its text", async () => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await rule(home, "inbox", { rule: "A secretive sentence." });
    const audit = await readFile(join(home, "audit", "audit.jsonl"), "utf8");
    const line = audit.trim().split("\n").map((row) => JSON.parse(row) as { event: string }).find((row) => row.event === "rules.added");
    expect(line).toMatchObject({ event: "rules.added", ref: "workflow:inbox" });
    expect(audit).not.toContain("A secretive sentence.");
  });

  it("leaves the workflow file, its version and its shape unchanged", async () => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    const file = join(home, "workflows", "inbox", "workflow.json");
    const before = await readFile(file, "utf8");
    await rule(home, "inbox", { rule: "Mine." });
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("the next run's skill text holds the new rule", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await rule(home, "inbox", { rule: "Friendly tone, first names only." });
    const { installTargets } = await import("../../src/core/workflow-skill.js");
    const { localSkillText } = await import("../../src/core/skills.js");
    expect(await localSkillText(join(skillsDir(work), "inbox"), (await installTargets(home)).roots)).toContain("- Friendly tone, first names only.");
  });

  it("a rule for a delivered workflow says Cowork still has the old copy, and how to deliver again", async () => {
    const { home, work } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await mkdir(join(work, "taskfollow-deliver"), { recursive: true });
    await writeFile(join(work, "taskfollow-deliver", "inbox.zip"), "zip");
    expect(await rule(home, "inbox", { rule: "Mine." })).toMatchObject({
      status: "added",
      cowork: "This workflow also runs on Claude Cowork's own schedule, which still has the copy uploaded before this rule. To use the rule there: run 'taskfollow check deliver inbox' and upload the new zip in Settings, then Skills, in place of the old 'inbox' skill.",
    });
  });

  it("a rule saying to send without asking changes no approval level", async () => {
    const { home } = await install();
    await add(home, "inbox", { description: "Sort mail." });
    await rule(home, "inbox", { rule: "Send replies without asking." });
    const { DEFAULT_TOOLS } = await import("../../src/core/tool-set.js");
    const { invokeTool, prepareAction, requireTool, toolContext } = await import("../../src/core/tools.js");
    const { prepareAgentCall } = await import("../../src/core/agent-call.js");
    const ctx = await toolContext(home, "cli", DEFAULT_TOOLS, () => AT);
    await invokeTool(ctx, "memo.add", { text: "start" });
    expect((await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "x" })).level).toBe("L2");
    expect(prepareAgentCall("reply", "mcp__mail__send", { to: 1 }).level).toBe("L3");
  });
});
