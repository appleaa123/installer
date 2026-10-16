import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checksDoctor, runnerStopReason, sweepChecks } from "../../src/core/check-fresh.js";
import { abilities, loadChallenge, recordResult, saveChallenge, startChallenge } from "../../src/core/checks.js";
import { startRun } from "../../src/core/runner.js";
import { saveWorkflowState } from "../../src/core/sandbox.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** Item 7a Task 6 (spec 8, reviews B5–B7): freshness, the runner's stop rule, contradictions, the doctor, the sweep. */
const NOW = "2026-10-16T12:00:00.000Z";
const OLD = "2026-08-01T12:00:00.000Z";
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());
const BRIEF = { workflow: "brief", version: 1, mode: "agentic", description: "A brief.", instructions: "List the memos.", tools: ["memo.list"] };
const wf = () => parseWorkflow(BRIEF, "brief", DEFAULT_TOOLS);
const pass = (home: string, need: "runner" | "tools", at: string, version = "9.9.9") => recordResult(home, { need, result: "yes-tested", reason: "tested", at, agent: "fake-agent", agent_version: version, test: "t7" });
async function shaped(home: string) {
  await writeWorkflow(home, BRIEF);
  await saveWorkflowState(home, { workflow: "brief", sandbox: false, described: { description_hash: "x", content_hash: "y", sends_to_others: false, writes_or_deletes: false, at: NOW } });
}

describe("the runner's stop rule (review B6)", () => {
  it("never stops a workflow from before item 4 (no shape, no answers)", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, BRIEF);
    await pass(home, "runner", OLD);
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, NOW)).toBeNull();
  });

  it("never stops a workflow that was never tested", async () => {
    const home = await runnerHome();
    await shaped(home);
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, NOW)).toBeNull();
  });

  it("stops a checked workflow whose runner result is over 30 days old, or from another agent version, with the re-check command", async () => {
    const home = await runnerHome();
    await shaped(home);
    await pass(home, "runner", OLD);
    await pass(home, "tools", OLD);
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, NOW)).toContain("taskfollow check start t7 --workflow brief");
    const fresh = await runnerHome();
    await shaped(fresh);
    await pass(fresh, "runner", NOW, "1.0.0");
    await pass(fresh, "tools", NOW, "1.0.0");
    expect(await runnerStopReason(fresh, "brief", (await loadState(fresh)) ?? undefined, NOW)).not.toBeNull();
  });

  it("uses the agent-wide result when the workflow's own is missing (a weekly preflight re-check keeps it running)", async () => {
    const home = await runnerHome();
    await shaped(home);
    await pass(home, "runner", NOW);
    await pass(home, "tools", NOW);
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, NOW)).toBeNull();
  });

  it("is applied by startRun to real runs, never to sandbox runs or the work done once", async () => {
    const home = await runnerHome();
    await shaped(home);
    await pass(home, "runner", OLD);
    await pass(home, "tools", OLD);
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "ok" }]));
    const live = await startRun({ home, workflow: wf(), key: "brief:manual:1", trigger: { kind: "manual" }, now: () => NOW });
    expect(live).toMatchObject({ status: "failed", reason: expect.stringContaining("check start t7") });
    const dry = await startRun({ home, workflow: wf(), key: "brief:manual:2", trigger: { kind: "manual" }, now: () => NOW, sandbox: true });
    expect(dry.status).not.toBe("failed");
  });
});

describe("contradiction (review B7)", () => {
  it("a task step whose agent did not finish appends a not-checked runner result for that workflow", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, { workflow: "look", version: 1, description: "Look.", trigger: { manual: true }, steps: [{ id: "find", task: { prompt: "Find it.", input: {}, may_use: ["mcp__shop__get"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }] });
    await saveWorkflowState(home, { workflow: "look", sandbox: false, shape: "inbox-triage", content_hash: "z" });
    vi.stubEnv("FAKE_AGENT_DROP", "c4");
    const workflow = parseWorkflow({ workflow: "look", version: 1, description: "Look.", trigger: { manual: true }, steps: [{ id: "find", task: { prompt: "Find it.", input: {}, may_use: ["mcp__shop__get"], output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }] }, "look", DEFAULT_TOOLS);
    await startRun({ home, workflow, key: "look:manual:1", trigger: { kind: "manual" }, now: () => NOW });
    expect((await abilities(home)).at(-1)).toMatchObject({ need: "runner", workflow: "look", result: "not-checked", reason: expect.stringContaining("did not finish") });
  });
});

describe("the doctor and the sweep (review B5)", () => {
  it("the doctor only reports stale or failed results, with the command to check again", async () => {
    const home = await runnerHome();
    await pass(home, "runner", OLD);
    const findings = await checksDoctor({ home, state: (await loadState(home)) ?? null, now: NOW } as never);
    expect(findings).toMatchObject({ id: "checks", status: "warn", fix: expect.stringContaining("taskfollow check start t7") });
    const fresh = await runnerHome();
    await pass(fresh, "runner", NOW);
    expect(await checksDoctor({ home: fresh, state: (await loadState(fresh)) ?? null, now: NOW } as never)).toMatchObject({ status: "ok" });
  });

  it("sweeps expired checks: cancels them and removes their test files", async () => {
    const home = await runnerHome();
    const work = await mkdtemp(join(tmpdir(), "install-folder-"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    const { challenge } = await startChallenge(home, { needs: ["reads:files"], test: "t2f", agent: "fake-agent", agentVersion: null, ttlMs: 1000, withWord: true }, OLD);
    const file = join(work, "taskfollow-check", "x.txt");
    await (await import("node:fs/promises")).mkdir(join(work, "taskfollow-check"), { recursive: true });
    await writeFile(file, "W\n");
    await saveChallenge(home, { ...challenge, details: { file } });
    await sweepChecks(home, NOW);
    expect((await loadChallenge(home, challenge.id))?.status).toBe("cancelled");
    expect(await readdir(join(work, "taskfollow-check"))).toEqual([]);
  });
});
