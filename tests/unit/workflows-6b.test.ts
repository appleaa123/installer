import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { consultCleanup, restoreAfterConsult } from "../../src/core/consult.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { DISCOVERY_SKILL, loadWritten, removeWritten, writeDiscoverySkill } from "../../src/core/workflow-skill.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadWorkflowState } from "../../src/core/sandbox.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 6b (D165, D172): the interview proposes from the shipped shapes, operator rule 14, the discovery skill. */
const RAW = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { workflows: Record<string, unknown>[]; steps: Record<string, unknown>[] };
const STARTER = parseSolution(RAW);
const AT = "2026-10-16T12:00:00.000Z";
const intentOf = (id: string): string => String(STARTER.steps.find((step) => step.step_id === id)?.intent ?? "");
const END_LINE = "Not sure what repeats in your week? Ask me to find your repetitive work any time.";

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

describe("the interview proposes from the shipped shapes (Task 7)", () => {
  it("the interview intent names the shipped shapes, asks which tool the person uses, and says a named tool makes a described workflow", () => {
    const intent = intentOf("workflows.choose");
    for (const shape of ["inbox triage", "lead qualification", "CRM update", "invoice processing", "invoices due", "meeting follow-up"]) expect(intent).toContain(shape);
    expect(intent).toContain("which tool they use for that work today");
    expect(intent).toContain('"examples"');
    expect(intent).toContain("described workflow");
    expect(intent).toContain(END_LINE);
  });

  it("the consultation's interview asks the same, and ends with the same one line", () => {
    const intent = intentOf("consult.choose");
    expect(intent).toContain("taskfollow workflow suggestions");
    expect(intent).toContain("which tool they use for that work today");
    expect(intent).toContain(END_LINE);
  });

  it("starter 2.3.0", () => {
    expect(STARTER.version).toBe("2.3.0");
  });

  it("a shape added with the person's rules and examples keeps its shape and writes both", async () => {
    const home = await runnerHome();
    const work = await mkdtemp(join(tmpdir(), "install-folder-"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    const { when: _when, ...lead } = RAW.workflows.find((flow) => flow.workflow === "lead-qualification") ?? {};
    await writePinnedSolution(home, JSON.stringify({ id: "fixture-6b", version: "1.0.0", workflows: [lead], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] }));
    const added = await workflowCommand(home, "add", "lead-qualification", JSON.stringify({ my_rules: "A fit is anyone who rents in Toronto.", examples: "Jo asked about a 2-bedroom: fit, send the listing." }), () => AT);
    const folder = String(added.skill_folder);
    expect(await readFile(join(folder, "references", "my-rules.md"), "utf8")).toContain("rents in Toronto");
    expect(await readFile(join(folder, "references", "examples.md"), "utf8")).toContain("2-bedroom");
    expect((await loadWorkflowState(home, "lead-qualification"))?.shape).toBe("lead-qualification");
  });
});

describe("discovery: the find-my-repetitive-work skill (Task 9, D165)", () => {
  const SKILL_TEXT = readFileSync("solutions/skills/find-my-repetitive-work/SKILL.md", "utf8");

  /** A runner home whose install folder is known, so the agent's project skills folder is `<work>/.claude/skills`. */
  async function installHome(): Promise<{ home: string; work: string }> {
    const home = await runnerHome();
    const work = await mkdtemp(join(tmpdir(), "install-folder-"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    return { home, work };
  }

  it("the WORKFLOWS phase writes the discovery skill and records it", async () => {
    const step = STARTER.steps.find((entry) => entry.step_id === "workflows.discovery");
    expect(step).toMatchObject({ phase: "WORKFLOWS", type: "auto", auto: { action: "discovery_skill" } });
    expect(step?.when).toBeUndefined();
    const ids = STARTER.steps.map((entry) => entry.step_id);
    expect(ids.indexOf("workflows.discovery")).toBeLessThan(ids.indexOf("workflows.choose"));
    expect(ids.indexOf("workflows.discovery")).toBeLessThan(ids.indexOf("consult.choose"));
    const { home, work } = await installHome();
    await runAction(home, { action: "discovery_skill" }, (await loadState(home)) ?? undefined);
    const folder = join(work, ".claude", "skills", DISCOVERY_SKILL);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
    expect((await loadWritten(home)).skill_folders).toEqual([{ workflow: DISCOVERY_SKILL, path: folder, root: join(work, ".claude", "skills") }]);
    await runAction(home, { action: "discovery_skill" }, (await loadState(home)) ?? undefined);
    expect((await loadWritten(home)).skill_folders).toHaveLength(1);
  });

  it("uninstall and the consult cleanup remove it, and add install writes it again", async () => {
    const { home, work } = await installHome();
    const folder = join(work, ".claude", "skills", DISCOVERY_SKILL);
    await writeDiscoverySkill(home);
    await removeWritten(home);
    await expect(readFile(join(folder, "SKILL.md"), "utf8")).rejects.toThrow();
    await writeDiscoverySkill(home);
    await consultCleanup(home, (await loadState(home)) ?? undefined, AT);
    await expect(readFile(join(folder, "SKILL.md"), "utf8")).rejects.toThrow();
    await restoreAfterConsult(home);
    expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe(SKILL_TEXT);
  });

  it("an agent without a skills folder gets it under exports/", async () => {
    const home = await runnerHome();
    const written = await writeDiscoverySkill(home);
    expect(written.path).toBe(join(home, "exports", DISCOVERY_SKILL, "SKILL.md"));
    expect(await readFile(written.path, "utf8")).toBe(SKILL_TEXT);
    expect((await loadWritten(home)).skill_folders).toEqual([]);
  });

  it("its text names no TaskFollow command but workflow add, workflow suggestions and skills", () => {
    const commands = [...SKILL_TEXT.matchAll(/taskfollow ([a-z]+(?: [a-z]+)?)/g)].map((match) => match[1]);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(["workflow add", "workflow suggestions", "skills"]).toContain(command);
    expect(SKILL_TEXT).not.toContain("mcp__installer");
    for (const rule of ["Read only.", "Quote no message", "only in this chat", "only after their yes"]) expect(SKILL_TEXT).toContain(rule);
  });

  it("INSTALL.md 9b says what to do when the person is not sure what repeats", () => {
    const doc = readFileSync("INSTALL.md", "utf8");
    expect(doc).toContain("**If the person is not sure what repeats.**");
    expect(doc).toContain(`exports/${DISCOVERY_SKILL}/SKILL.md`);
  });
});
