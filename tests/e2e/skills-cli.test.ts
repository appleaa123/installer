import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { runnerHome } from "../helpers/runner-home.js";

/** 9.12 item 2 through the real CLI: `skills` lists, `workflow add` writes into the install folder and nowhere else. */
const SOLUTION = { id: "fixture-runner", version: "1.0.0", workflows: [], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };

describe("taskfollow skills and workflow add (9.12 item 2)", () => {
  it("lists the install folder's skill, then writes the workflow's own skill and the CLAUDE.md section there only", async () => {
    const home = await runnerHome();
    const work = await mkdtemp(join(tmpdir(), "install-folder-"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    await writePinnedSolution(home, JSON.stringify(SOLUTION));
    // The person's own skill folder is shared by the whole test run, so only the install folder's skills are compared.
    const fromInstall = (json: unknown) => ((json as { skills: { source: string }[] }).skills ?? []).filter((entry) => entry.source === "install folder");
    const before = runCli(["skills"], { home }).json;
    expect(before).toMatchObject({ notes: [], next: expect.stringContaining("add only the ones they confirm") });
    expect(fromInstall(before)).toEqual([]);
    const added = runCli(["workflow", "add", "inbox", "--value", JSON.stringify({ description: "Sort mail.", tools: ["memo.list"], my_rules: "Flag repairs." })], { home });
    expect(added).toMatchObject({ code: 0, json: { status: "added", skill_folder: join(work, ".claude", "skills", "inbox") } });
    expect(fromInstall(runCli(["skills"], { home }).json)).toEqual([expect.objectContaining({ name: "inbox", ref: join(work, ".claude", "skills", "inbox") })]);
    expect((await readdir(work)).sort()).toEqual([".claude", "CLAUDE.md"]);
    expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toContain("- **inbox**: Sort mail.");
  });
});
