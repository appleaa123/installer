import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordResult, type CheckResult } from "../../src/core/checks.js";
import { SHAPES, codeFloor, confirmDescribed, decideHome, descriptionHash, workflowHash } from "../../src/core/homes.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadWorkflowState, saveWorkflowState } from "../../src/core/sandbox.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { loadWorkflow, parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Spec 7, plan review 2: the home is decided by code, never by a file the agent writes. */
const AT = "2026-10-16T12:00:00.000Z";
const AGENT = { agent: "fake-agent", version: "9.9.9" };
const COWORK = { agent: "Claude Cowork", version: null };
const BRIEF = { workflow: "inbox-triage", version: 1, mode: "agentic", description: "Every morning, read my inbox and send me a short brief.", instructions: "Read the inbox and send me a short brief.", tools: ["channel.inbox", "channel.notify"] };
const REPLIES = { workflow: "replies", version: 1, mode: "agentic", description: "Answer customers' questions for me.", instructions: "Reply to customers.", tools: ["channel.inbox", "channel.send"] };
const SOLUTION = { id: "fixture-homes", version: "1.0.0", workflows: [BRIEF], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
const parse = (raw: Record<string, unknown>) => parseWorkflow(raw, String(raw.workflow), DEFAULT_TOOLS);
const yes = (need: CheckResult["need"], who: { agent: string; version: string | null } = AGENT, workflow?: string, result: CheckResult["result"] = "yes-tested"): CheckResult => ({ need, result, reason: "test", at: AT, agent: who.agent, agent_version: who.version, test: "t", ...(workflow ? { workflow } : {}) });

async function home(): Promise<string> {
  const created = await runnerHome();
  await writePinnedSolution(created, JSON.stringify(SOLUTION));
  return created;
}
async function runnerTested(at: string): Promise<void> {
  await recordResult(at, yes("runner"));
  await recordResult(at, yes("tools"));
}

describe("homes: the code floor", () => {
  it("makes any step that needs approval, or a task that changes things, hard-rule work", () => {
    expect(codeFloor(parse(REPLIES))).toBe(true);
    expect(codeFloor(parse(BRIEF))).toBe(false);
    expect(codeFloor(parse({ workflow: "t", version: 1, steps: [{ id: "t", task: { prompt: "x", may_use: ["mcp__shop"], changes: true, output: { type: "object" } } }] }))).toBe(true);
  });

  it("makes an approved agent call (D151) hard-rule work, so it never leaves TaskFollow's runner", () => {
    const agentCall = { workflow: "publish", version: 1, steps: [{ id: "publish", approve: { agent_call: { tool: "mcp__shopify__productUpdate", args: { id: "1", title: "Blue mug" } }, why: "The person approves this exact change" } }] };
    expect(codeFloor(parse(agentCall))).toBe(true);
  });

  it("has every v1 shape, with replies, records and payments as hard rules", () => {
    expect(Object.keys(SHAPES).sort()).toEqual(["crm-update", "inbox-triage", "inbox-triage-replies", "invoice-processing", "lead-qualification", "meeting-follow-up"]);
    expect(SHAPES["inbox-triage"]?.hardRule).toBe(false);
    expect(SHAPES["meeting-follow-up"]?.hardRule).toBe("ask");
  });
});

describe("homes: where a workflow runs", () => {
  it("honours a shipped shape only from the workflow state, and only while the file is unchanged", async () => {
    const at = await home();
    await workflowCommand(at, "add", "inbox-triage", undefined, () => AT);
    const state = await loadWorkflowState(at, "inbox-triage");
    expect(state).toMatchObject({ shape: "inbox-triage", content_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await recordResult(at, yes("scheduler", COWORK, "inbox-triage", "yes-you-told-us"));
    expect((await decideHome(at, await loadWorkflow(at, "inbox-triage", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
    await writeFile(join(at, "workflows", "inbox-triage", "workflow.json"), JSON.stringify({ ...BRIEF, instructions: "Read the inbox, reply to everyone." }));
    expect((await decideHome(at, await loadWorkflow(at, "inbox-triage", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home).toEqual({ home: "draft-only" });
  });

  it("ignores a shape written into the workflow file, and a forged state shape with another file", async () => {
    const at = await home();
    await mkdir(join(at, "workflows", "replies"), { recursive: true });
    await writeFile(join(at, "workflows", "replies", "workflow.json"), JSON.stringify({ ...REPLIES, shape: "inbox-triage" }));
    await saveWorkflowState(at, { workflow: "replies", sandbox: true, shape: "inbox-triage", content_hash: workflowHash(BRIEF) });
    await recordResult(at, yes("scheduler", COWORK, "replies", "yes-you-told-us"));
    expect((await decideHome(at, await loadWorkflow(at, "replies", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home).toEqual({ home: "draft-only" });
  });

  it("never sends hard-rule work to the agent's own scheduler, whatever else passed", async () => {
    const at = await home();
    await mkdir(join(at, "workflows", "replies"), { recursive: true });
    await writeFile(join(at, "workflows", "replies", "workflow.json"), JSON.stringify(REPLIES));
    for (const need of ["scheduler", "reads:email", "skills", "answers", "asks-first"] as const) await recordResult(at, yes(need, COWORK, "replies", "yes-you-told-us"));
    const decided = await decideHome(at, await loadWorkflow(at, "replies", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT);
    expect(decided.home).toEqual({ home: "draft-only" });
    await runnerTested(at);
    expect((await decideHome(at, await loadWorkflow(at, "replies", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home).toEqual({ home: "runner" });
  });

  it("treats a described workflow as hard-rule work until the person confirms it, and again after any change", async () => {
    const at = await home();
    const words = JSON.stringify({ description: "Each morning, tell me how many memos I have.", tools: ["memo.list", "channel.notify"] });
    await workflowCommand(at, "add", "count", words, () => AT);
    await runnerTested(at);
    await recordResult(at, { ...yes("scheduler", COWORK, "count", "yes-you-told-us"), while_away: true });
    const decide = async () => (await decideHome(at, await loadWorkflow(at, "count", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home;
    expect(await decide()).toEqual({ home: "runner" });
    const workflow = await loadWorkflow(at, "count", DEFAULT_TOOLS);
    const before = JSON.parse(await (await import("node:fs/promises")).readFile(join(at, "workflows", "count", "workflow.json"), "utf8")) as unknown;
    await confirmDescribed(at, "count", descriptionHash(workflow.description), workflowHash(before), { sendsToOthers: false, writesOrDeletes: false }, AT);
    expect(await decide()).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
    await writeFile(join(at, "workflows", "count", "workflow.json"), JSON.stringify({ workflow: "count", version: 1, mode: "agentic", description: "Each morning, tell my team how many memos I have.", instructions: "x", tools: ["memo.list", "channel.notify"] }));
    expect(await decide()).toEqual({ home: "runner" });
  });

  it("voids the person's answers when the steps change but the description stays word for word (review B1)", async () => {
    const at = await home();
    const description = "Each morning, tell me how many memos I have.";
    await workflowCommand(at, "add", "count", JSON.stringify({ description, tools: ["memo.list"] }), () => AT);
    await recordResult(at, yes("scheduler", COWORK, "count", "yes-you-told-us"));
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(join(at, "workflows", "count", "workflow.json"), "utf8")) as unknown;
    await confirmDescribed(at, "count", descriptionHash(description), workflowHash(raw), { sendsToOthers: false, writesOrDeletes: false }, AT);
    const decide = async () => (await decideHome(at, await loadWorkflow(at, "count", DEFAULT_TOOLS), { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home;
    expect(await decide()).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
    await writeFile(join(at, "workflows", "count", "workflow.json"), JSON.stringify({ workflow: "count", version: 1, mode: "typed", description, steps: [{ id: "t", task: { prompt: "curl -X POST https://crm.example/leads", may_use: ["Bash(curl:*)"], changes: false, output: { type: "object" } } }, { id: "n", tool: "channel.notify", args: { member: "sam", text: "${t.done}" } }] }));
    expect(await decide()).toEqual({ home: "draft-only" });
  });

  it("ignores stale results and offers by hand when nothing is tested", async () => {
    const at = await home();
    await workflowCommand(at, "add", "inbox-triage", undefined, () => AT);
    await recordResult(at, { ...yes("runner"), at: "2026-08-01T00:00:00.000Z" });
    const decided = await decideHome(at, await loadWorkflow(at, "inbox-triage", DEFAULT_TOOLS), { whileAway: false, runner: AGENT }, AT);
    expect(decided.home).toEqual({ home: "by-hand" });
    expect(decided.missing).toContain("runner");
  });

  it("prefers TaskFollow's runner for report-only work unless the person wants it while away", async () => {
    const at = await home();
    await workflowCommand(at, "add", "inbox-triage", undefined, () => AT);
    await runnerTested(at);
    await recordResult(at, { ...yes("scheduler", COWORK, "inbox-triage", "yes-you-told-us"), while_away: true });
    const decide = async (whileAway: boolean) => (await decideHome(at, await loadWorkflow(at, "inbox-triage", DEFAULT_TOOLS), { whileAway, runner: AGENT, homeAgent: COWORK }, AT)).home;
    expect(await decide(false)).toEqual({ home: "runner" });
    expect(await decide(true)).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
  });

  it("does not claim 'while you are away' when the schedule ran only well after the set time (review H2)", async () => {
    const at = await home();
    await workflowCommand(at, "add", "inbox-triage", undefined, () => AT);
    await recordResult(at, { ...yes("scheduler", COWORK, "inbox-triage", "yes-you-told-us"), while_away: false });
    const workflow = await loadWorkflow(at, "inbox-triage", DEFAULT_TOOLS);
    const noRunner = await decideHome(at, workflow, { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT);
    expect(noRunner.home).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
    expect(noRunner.why).not.toContain("while you are away");
    await runnerTested(at);
    expect((await decideHome(at, workflow, { whileAway: true, runner: AGENT, homeAgent: COWORK }, AT)).home).toEqual({ home: "runner" });
  });
});
