import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { setSecret } from "../../src/core/keychain.js";
import { checkPacks, loadPacks } from "../../src/core/packs.js";
import { startRun } from "../../src/core/runner.js";
import { packsCommand, shadowPack, switchPack } from "../../src/core/shadow.js";
import { loadState, saveState } from "../../src/core/state.js";
import { HEARTBEAT_FILE } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { loadWorkflow } from "../../src/core/workflow.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { OWNER_ROLES, runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA, writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const VALID = { label: "now", confidence: 0.9 };
/** A judge that reads a Skills Wiki skill, then a memo with its label. */
const SORT = { workflow: "sort", version: 1, steps: [{ id: "label", judge: { instructions: "Label the request.", input: "${run.id}", schema: LABEL_SCHEMA, skill: "skillswiki:demo/judge/guide.md" } }, { id: "note", tool: "memo.add", args: { text: "${label.label}" } }] };
let fake: FakeMcp;
let served: string;
let runs = 0;
beforeAll(async () => {
  served = await makeTempHome();
  fake = await startFakeMcp({ FAKE_MCP_DIR: served });
  await setSecret("skillswiki", fake.key);
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

async function serve(text: string): Promise<void> {
  await mkdir(join(served, "demo", "judge"), { recursive: true });
  await writeFile(join(served, "demo", "judge", "guide.md"), text);
}

/** A home whose `sort` workflow pinned version one of the guide, while Skills Wiki now serves version two. */
async function updatedHome(answers: readonly unknown[] = [VALID]): Promise<string> {
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(answers));
  const home = await runnerHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, skillswiki: { url: fake.url } });
  await writeWorkflow(home, SORT);
  await serve("Version one of the guide.");
  await run(home);
  await serve("Version two of the guide.");
  return home;
}

const run = async (home: string) => startRun({ home, workflow: await loadWorkflow(home, "sort", DEFAULT_TOOLS), key: `sort:${++runs}`, trigger: { kind: "manual" }, now: () => AT });
const skillsSeen = async (home: string): Promise<string[]> =>
  (await readFile(join(home, "runtime", "judge", ".fake-agent", "judge-calls.jsonl"), "utf8")).trim().split("\n").map((line) => /--- skill ---\n([\s\S]*?)\n--- end of skill ---/.exec((JSON.parse(line) as { prompt: string }).prompt)?.[1] ?? "");
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("the shadow upgrade (§14.3, D108)", () => {
  it("runs each workflow that reads the pack in sandbox, on the pinned and on the candidate text, and compares them", async () => {
    const home = await updatedHome();
    await checkPacks(home, fake.url, AT);
    const result = await shadowPack(home, "demo", () => AT);
    expect(result).toMatchObject({ passed: true, evals: [{ name: "shadow-runs", passed: true, detail: "1 workflow(s) did as well on the candidate" }] });
    expect(result.comparisons).toEqual([{ workflow: "sort", pinned: expect.objectContaining({ status: "completed", recorded: 1, needs_human: 0 }), candidate: expect.objectContaining({ status: "completed", recorded: 1, needs_human: 0 }) }]);
    expect((await skillsSeen(home)).slice(-2)).toEqual(["Version one of the guide.", "Version two of the guide."]);
    expect(await memos(home)).toEqual(["now"]);
    expect((await loadPacks(home)).demo?.candidate?.shadow).toMatchObject({ passed: true, version: result.version });
    expect(await shadowPack(home, "demo", () => AT)).toMatchObject({ comparisons: result.comparisons });
    expect(await events(home)).toEqual(expect.arrayContaining(["pack.shadow_ran", "pack.announced"]));
  });

  it("does not pass a candidate that needs a person more often, and such a version cannot be switched", async () => {
    const home = await updatedHome([VALID, VALID, { label: "maybe" }]);
    await checkPacks(home, fake.url, AT);
    const result = await shadowPack(home, "demo", () => AT);
    expect(result).toMatchObject({ passed: false, evals: [{ detail: "worse on the candidate: sort (failed, 1 need a person)" }] });
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: true, as: "Owner" }, () => AT)).rejects.toThrow("have not passed");
  });

  it("is switched by the decision maker alone, in their own terminal; judges then read the new version", async () => {
    const home = await updatedHome();
    await checkPacks(home, fake.url, AT);
    await shadowPack(home, "demo", () => AT);
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: false }, () => AT)).rejects.toThrow("in their own terminal");
    await expect(switchPack(home, "demo", OWNER_ROLES, { interactive: true, as: "Ada" }, () => AT)).rejects.toThrow("only the decision maker");
    expect((await events(home)).filter((event) => event === "pack.switch_refused")).toHaveLength(2);
    const candidate = (await loadPacks(home)).demo?.candidate?.version;
    expect(await packsCommand(home, "switch", "demo", OWNER_ROLES, { interactive: true, as: "Owner" }, () => AT)).toMatchObject({ status: "switched", to: candidate, by: "Owner" });
    expect((await loadPacks(home)).demo).toEqual(expect.objectContaining({ version: candidate }));
    expect((await loadPacks(home)).demo?.candidate).toBeUndefined();
    await run(home);
    expect((await skillsSeen(home)).at(-1)).toBe("Version two of the guide.");
    expect(await events(home)).toContain("pack.switched");
  });

  it("is started by the doctor, which finds the new version, runs the shadow and leaves the switch to the decision maker", async () => {
    const home = await updatedHome();
    await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
    const report = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3 });
    expect(report.checks.find((check) => check.id === "packs")).toMatchObject({ status: "warn", detail: "demo: a new version, shadow passed", fix: expect.stringContaining("installer packs switch <pack>") });
    expect(await packsCommand(home, "list", undefined, OWNER_ROLES, { interactive: false }, () => AT)).toMatchObject({ packs: [{ pack: "demo", candidate: { shadow: { passed: true } } }] });
    await expect(packsCommand(home, "shadow", undefined, OWNER_ROLES, { interactive: false }, () => AT)).rejects.toThrow("packs takes:");
  });
});
