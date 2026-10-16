import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { abilities, recordResult } from "../../src/core/checks.js";
import { consultCleanup, consultReport, consultReportPath, restoreAfterConsult } from "../../src/core/consult.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import { workflowIds } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Plan item 7 Task 8 (spec section 9): the consult leaves only its results, and its report is the client's to forward. */
const AT = "2026-10-16T12:00:00.000Z";
const SOLUTION = { id: "fixture-consult", version: "1.0.0", workflows: [], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };

async function consultHome(): Promise<{ home: string; work: string }> {
  const home = await runnerHome();
  const work = await mkdtemp(join(tmpdir(), "consult-folder-"));
  const state = await loadState(home);
  // The real consult path: no mode.name (install-only); the consult asks for the names to leave out (consult.names).
  if (state) await saveState(home, { ...state, work_dir: work, steps: { ...state.steps, "mode.purpose": { status: "done", at: AT, by: "human", value: "consult" }, "consult.names": { status: "done", at: AT, by: "human", value: "Marisol Okafor, Okafor Realty" } } });
  await writePinnedSolution(home, JSON.stringify(SOLUTION));
  await writeFile(join(work, "CLAUDE.md"), "# Mine\n");
  await workflowCommand(home, "add", "brief", JSON.stringify({ description: "Each morning, tell Marisol Okafor of Okafor Realty what is in her inbox; copy sam@example.com and call 4165550199.", tools: ["memo.list"], my_rules: "Flag every repair." }), () => AT);
  await recordResult(home, { need: "answers", workflow: "brief", result: "yes-you-told-us", reason: "You saw it", at: AT, agent: "fake-agent", agent_version: "9.9.9", test: "once" });
  return { home, work };
}

describe("consult: the report and the clean-up (item 7 Task 8)", () => {
  it("writes the report under the TaskFollow home's exports, scrubbed, with a note to read it before forwarding", async () => {
    const { home } = await consultHome();
    const { file } = await consultReport(home, (await loadState(home)) ?? undefined, AT);
    expect(file.startsWith(join(home, "exports"))).toBe(true);
    const text = await readFile(file, "utf8");
    expect(text).toContain("Removed from this report: your name, your business's name, email addresses and long numbers. Read it before forwarding: names of other people in your own words stay.");
    expect(text).toContain("brief");
    expect(text).toContain("Done once, now");
    for (const leaked of ["Marisol Okafor", "Okafor Realty", "sam@example.com", "4165550199"]) expect(text).not.toContain(leaked);
    expect(text).toContain("taskfollow add install");
    expect(await consultReportPath(home)).toBe(join("exports", "consult-report-2026-10-16.md"));
    await consultCleanup(home, (await loadState(home)) ?? undefined, AT);
    expect(await consultReportPath(home)).toBe(join("exports", "consult-report-2026-10-16.md"));
  });

  it("removes the workflow's skill folder and the CLAUDE.md section, keeps results, workflows and rules", async () => {
    const { home, work } = await consultHome();
    const done = await consultCleanup(home, (await loadState(home)) ?? undefined, AT);
    expect(done.skill_folders).toHaveLength(1);
    expect(await readdir(join(work, ".claude", "skills"))).toEqual([]);
    expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toBe("# Mine\n");
    expect(await workflowIds(home)).toEqual(["brief"]);
    expect((await abilities(home)).length).toBeGreaterThan(0);
  });

  it("puts the workflow back with its own rules when the person continues to an install", async () => {
    const { home, work } = await consultHome();
    await consultCleanup(home, (await loadState(home)) ?? undefined, AT);
    const restored = await restoreAfterConsult(home);
    expect(restored.skill_folders).toEqual([join(work, ".claude", "skills", "brief")]);
    expect(await readFile(join(work, ".claude", "skills", "brief", "references", "my-rules.md"), "utf8")).toContain("Flag every repair.");
    expect(await readFile(join(work, "CLAUDE.md"), "utf8")).toContain("- **brief**");
  });

  it("removes the scheduled-job test's zip and the empty test folders, and keeps delivered workflows", async () => {
    const { home, work } = await consultHome();
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(join(work, "taskfollow-deliver"), { recursive: true });
    await mk(join(work, "taskfollow-check"), { recursive: true });
    await writeFile(join(work, "taskfollow-deliver", "taskfollow-check-skill.zip"), "zip");
    await writeFile(join(work, "taskfollow-deliver", "brief.zip"), "a delivered workflow");
    await writeFile(join(work, "taskfollow-check", "probe.txt"), "word");
    const { startChallenge, saveChallenge } = await import("../../src/core/checks.js");
    const { challenge } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "Claude Cowork", agentVersion: null, ttlMs: 60_000 }, AT);
    await saveChallenge(home, { ...challenge, details: { zip: join(work, "taskfollow-deliver", "taskfollow-check-skill.zip"), file: join(work, "taskfollow-check", "probe.txt") } });
    await consultCleanup(home, (await loadState(home)) ?? undefined, AT);
    expect(await readdir(join(work, "taskfollow-deliver"))).toEqual(["brief.zip"]);
    await expect(readdir(join(work, "taskfollow-check"))).rejects.toThrow();
  });
});

