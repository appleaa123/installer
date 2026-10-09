import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { approveItem, listApprovals } from "../../src/core/approvals.js";
import { hardenCommand, proposeHardening, replayGate, type Proposal } from "../../src/core/hardening.js";
import { resumeRun, startRun } from "../../src/core/runner.js";
import { runIdFor } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { dryrunCommand } from "../../src/core/lifecycle.js";
import { loadWorkflowState } from "../../src/core/sandbox.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { loadWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const AGENTIC = { workflow: "tidy", version: 1, mode: "agentic", instructions: "Read the memos, then note this run's id.", tools: ["memo.list", "memo.add", "memo.edit"] };
const TERMINAL = { interactive: true, as: "Ada" };
afterEach(() => vi.unstubAllEnvs());

const load = (home: string) => loadWorkflow(home, "tidy", DEFAULT_TOOLS);
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);

/** One run, `index` minutes after AT, in which the fake agent makes the calls `calls(runId)` and says done. */
async function agentRun(home: string, index: number, calls: (runId: string) => unknown[]) {
  const key = `tidy:manual:${index}`;
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([...calls(runIdFor(key, AT)), { tool: "done", summary: "noted" }]));
  const at = new Date(Date.parse(AT) + index * 60_000).toISOString();
  return startRun({ home, workflow: await load(home), key, trigger: { kind: "manual" }, now: () => at });
}

/** A person dry-runs the current version and confirms it, so its runs are live again. */
async function live(home: string): Promise<void> {
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "dry" }]));
  await dryrunCommand(home, "tidy", undefined, TERMINAL, () => AT);
  await dryrunCommand(home, "confirm", "tidy", TERMINAL, () => AT);
}

const NOTE = (runId: string) => [{ tool: "memo.list", args: {} }, { tool: "memo.add", args: { text: runId } }];

async function hardenable(runs = 5, calls = NOTE) {
  const home = await runnerHome();
  await writeWorkflow(home, AGENTIC);
  for (let index = 1; index <= runs; index += 1) expect(await agentRun(home, index, calls)).toMatchObject({ status: "completed" });
  return home;
}

describe("hardening proposals (§10.8, D93)", () => {
  it("needs five completed runs of the current version", async () => {
    const home = await hardenable(4);
    expect(await proposeHardening(home, await load(home))).toEqual({ reason: "4 completed runs of version 1; hardening needs 5" });
  });

  it("turns calls made the same way in every run into typed steps, with values found in the run's data", async () => {
    const home = await hardenable();
    const proposal = (await proposeHardening(home, await load(home))) as Proposal;
    expect(proposal).toMatchObject({
      workflow: "tidy", from_version: 1, agent_kept: false,
      promoted: [{ id: "call_1", tool: "memo.list", args: {} }, { id: "call_2", tool: "memo.add", args: { text: "${run.id}" } }],
    });
    expect(proposal.based_on).toHaveLength(5);
    expect(await replayGate(home, await load(home), proposal)).toMatchObject({ ok: true, runs: expect.arrayContaining([{ run_id: runIdFor("tidy:manual:1", AT), ok: true }]) });
  });

  it("keeps the agent for a call whose value it chose itself", async () => {
    const home = await hardenable(5, (runId) => [{ tool: "memo.list", args: {} }, { tool: "memo.add", args: { text: `Note ${runId.slice(-3)}!` } }]);
    expect(await proposeHardening(home, await load(home))).toMatchObject({ promoted: [{ id: "call_1", tool: "memo.list" }], agent_kept: true });
  });

  it("proposes nothing when the first call already needs judgment", async () => {
    const home = await hardenable(5, (runId) => [{ tool: "memo.add", args: { text: `Hello ${runId.slice(-2)}` } }]);
    expect(await proposeHardening(home, await load(home))).toEqual({ reason: "the agent's first call already needs judgment in these runs (or differs between them)" });
  });
});

describe("the replay gate and versions (§10.8)", () => {
  it("blocks the switch when an older run does not come out the same, and shows where", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, AGENTIC);
    for (const index of [1, 2]) await agentRun(home, index, () => [{ tool: "memo.list", args: {} }, { tool: "memo.add", args: { text: "fixed" } }]);
    for (const index of [3, 4, 5, 6, 7]) await agentRun(home, index, NOTE);
    const shown = await hardenCommand(home, "tidy", undefined, undefined, TERMINAL, () => AT);
    expect(shown).toMatchObject({ proposal: { promoted: [{ tool: "memo.list" }, { args: { text: "${run.id}" } }] }, replay: { ok: false } });
    expect((shown.replay as { runs: { ok: boolean; mismatch?: string }[] }).runs.filter((run) => !run.ok)).toEqual([
      { run_id: runIdFor("tidy:manual:1", AT), ok: false, mismatch: expect.stringContaining('the agent called memo.add {"text":"fixed"}') },
      { run_id: runIdFor("tidy:manual:2", AT), ok: false, mismatch: expect.stringContaining("the new step would call memo.add") },
    ]);
    await expect(hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT)).rejects.toThrow("The replay gate failed, so version 1 stays");
    expect((await load(home)).version).toBe(1);
  });

  it("applies in a person's terminal only, keeps the old version, and the new one runs without the model", async () => {
    const home = await hardenable();
    await expect(hardenCommand(home, "tidy", "apply", undefined, { interactive: false }, () => AT)).rejects.toThrow("in your own terminal");
    expect(await hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT)).toMatchObject({ status: "hardened", version: 2, kept: "workflows/tidy/versions/1", agent_kept: false });
    expect(JSON.parse(await readFile(join(home, "workflows/tidy/versions/1/workflow.json"), "utf8"))).toEqual(AGENTIC);
    const hardened = await load(home);
    expect(hardened).toMatchObject({ version: 2, mode: "typed", fallback: { tools: ["memo.list", "memo.add", "memo.edit"] } });
    await live(home);
    vi.stubEnv("FAKE_AGENT_JUDGE", "not json: the model must not be asked");
    const run = await startRun({ home, workflow: hardened, key: "tidy:manual:9", trigger: { kind: "manual" }, now: () => AT });
    expect(run).toMatchObject({ status: "completed", version: 2 });
    expect((await memos(home)).at(-1)).toBe(runIdFor("tidy:manual:9", AT));
  });

  it("never lowers a level: a call that needed approval still waits for a person once hardened (R7)", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "Old" });
    await writeWorkflow(home, AGENTIC);
    for (let index = 1; index <= 5; index += 1) {
      const waiting = await agentRun(home, index, (runId) => [{ tool: "memo.edit", args: { id: 1, text: runId } }]);
      await approveItem(home, waiting.waiting_on ?? 0, { name: "Ada", role: "member" }, AT);
      expect(await resumeRun({ home, workflow: await load(home), key: waiting.key, trigger: waiting.trigger, now: () => AT }, waiting)).toMatchObject({ status: "completed" });
    }
    expect(await hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT)).toMatchObject({ promoted: [{ tool: "memo.edit", args: { id: 1, text: "${run.id}" } }] });
    await live(home);
    const run = await startRun({ home, workflow: await load(home), key: "tidy:manual:20", trigger: { kind: "manual" }, now: () => AT });
    expect(run).toMatchObject({ status: "waiting", version: 2 });
    expect((await listApprovals(home, AT)).find((item) => item.id === run.waiting_on)).toMatchObject({ level: "L2", status: "pending", action: { args: { text: run.run_id } } });
  });

  it("puts a hardened version back in sandbox until a person confirms a dry run of it (D98)", async () => {
    const home = await hardenable();
    await hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT);
    expect(await loadWorkflowState(home, "tidy")).toEqual({ workflow: "tidy", sandbox: true });
    await expect(dryrunCommand(home, "confirm", "tidy", TERMINAL, () => AT)).rejects.toThrow("has no dry run of version 2 yet");
    expect(await startRun({ home, workflow: await load(home), key: "tidy:manual:30", trigger: { kind: "manual" }, now: () => AT })).toMatchObject({ version: 2, sandbox: true });
    expect(await memos(home)).not.toContain(runIdFor("tidy:manual:30", AT));
  });

  it("puts a rolled-back version back in sandbox until a person confirms a dry run of it (D98)", async () => {
    const home = await hardenable();
    await hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT);
    await live(home);
    await hardenCommand(home, "tidy", "rollback", "1", TERMINAL, () => AT);
    expect(await loadWorkflowState(home, "tidy")).toEqual({ workflow: "tidy", sandbox: true });
    await expect(dryrunCommand(home, "confirm", "tidy", TERMINAL, () => AT)).rejects.toThrow("has no dry run of version 3 yet");
  });

  it("rolls back to a kept version as a new version", async () => {
    const home = await hardenable();
    await hardenCommand(home, "tidy", "apply", undefined, TERMINAL, () => AT);
    expect(await hardenCommand(home, "tidy", "rollback", "1", TERMINAL, () => AT)).toEqual({ status: "rolled_back", workflow: "tidy", restored: 1, version: 3, sandbox: true, next: expect.stringContaining("installer dryrun tidy") });
    expect(await load(home)).toMatchObject({ version: 3, mode: "agentic" });
    await expect(hardenCommand(home, "tidy", "rollback", "7", TERMINAL, () => AT)).rejects.toThrow("has no kept version 7");
  });
});
