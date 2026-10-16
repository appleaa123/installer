import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, type CheckContext } from "../../src/core/check-commands.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** Item 7a Task 3 (spec 5.2 T4): a test skill in the agent's own skills folder; honest about what the word proves. */
const AT = "2026-10-16T12:00:00.000Z";
const ctx: CheckContext = { interactive: false, now: () => AT, launch: async () => ({ pid: 0, opened: false }) };
const run = async (home: string, args: string[], flags: Record<string, unknown> = {}) => checkCommand(home, (await loadState(home)) ?? undefined, args, flags, ctx);
async function install(work?: string) {
  const home = await runnerHome();
  const folder = work ?? (await mkdtemp(join(tmpdir(), "install-folder-")));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: folder });
  return { home, work: folder };
}

describe("T4 skills in chat", () => {
  it("writes a test skill in a randomly named folder, never shows the word, records an honest yes, and removes the folder", async () => {
    const { home, work } = await install();
    const out = (await run(home, ["start", "t4"])) as { id: string; instruction: string };
    const skills = join(work, ".claude", "skills");
    const [folder] = await readdir(skills);
    expect(folder).toMatch(/^taskfollow-check-[0-9a-f]+$/);
    const text = await readFile(join(skills, folder ?? "", "SKILL.md"), "utf8");
    const word = /answer with exactly: (\S+)/.exec(text)?.[1] ?? "";
    expect(word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect(JSON.stringify(out)).not.toContain(word);
    expect(await run(home, ["answer", out.id, word])).toMatchObject({ need: "skills", result: "yes, tested", why: expect.stringContaining("cannot tell") });
    expect(await stat(join(skills, folder ?? "")).then(() => true, () => false)).toBe(false);
  });

  it("says plainly it cannot run without the agent's own skills folder, and never writes into the home folder", async () => {
    const { home } = await install(homedir());
    expect(await run(home, ["start", "t4"])).toMatchObject({ need: "skills", result: "not checked" });
  });

  it("never shows a chat result as the workflow's skill on the person's page", async () => {
    const { home, work } = await install();
    await writeWorkflow(home, { workflow: "brief", version: 1, mode: "agentic", description: "A brief.", instructions: "x", tools: ["memo.list"] });
    const out = (await run(home, ["start", "t4", ], { workflow: "brief" })) as { id: string };
    const [folder] = await readdir(join(work, ".claude", "skills"));
    const word = /answer with exactly: (\S+)/.exec(await readFile(join(work, ".claude", "skills", folder ?? "", "SKILL.md"), "utf8"))?.[1] ?? "";
    await run(home, ["answer", out.id, word]);
    const summary = (await run(home, ["summary", "brief"])) as { lines: string[] };
    expect(summary.lines.find((line) => line.includes("Has the workflow's skill"))).toContain("not checked");
  });
});
