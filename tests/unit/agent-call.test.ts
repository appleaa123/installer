import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionHash, approveItem, getApproval, listApprovals } from "../../src/core/approvals.js";
import { resumeRun, startRun, type RunRequest } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-15T12:00:00.000Z";
const TOOL = "mcp__shopify__productUpdate";
const ARGS = { id: "gid://shopify/Product/1", title: "Blue mug", descriptionHtml: "<p>Hand made.</p>", status: "ACTIVE" };
const PUBLISH = { id: "publish", approve: { agent_call: { tool: TOOL, args: ARGS }, why: "Publish the new product as drafted" } };
const WORKFLOW = { workflow: "new-product", version: 1, description: "Publishes a product a person approved", trigger: { manual: true }, steps: [PUBLISH] };

let agentHome = "";
beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});
afterEach(() => vi.unstubAllEnvs());

const workflow = (value: Record<string, unknown> = WORKFLOW) => parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS);
const withStep = (approve: Record<string, unknown>) => workflow({ ...WORKFLOW, steps: [{ id: "publish", approve }] });
const request = (home: string, wf = workflow(), extra: Partial<RunRequest> = {}): RunRequest => ({ home, workflow: wf, key: `new-product:${AT}`, trigger: { kind: "manual" }, now: () => AT, ...extra });
const agentRan = async () => readFile(join(agentHome, "task-run.json"), "utf8").then(() => true, () => false);

describe("an approve step for a call to the agent's own tool (D151)", () => {
  it("reads the tool and the arguments", () => {
    expect(workflow().steps[0]).toMatchObject({ kind: "approve", agent_call: true, tool: TOOL, args: ARGS, why: "Publish the new product as drafted" });
  });

  it.each([
    [{ agent_call: { tool: "mcp__shopify__*", args: ARGS }, why: "x" }, "one exact MCP tool"],
    [{ agent_call: { tool: "mcp__shopify", args: ARGS }, why: "x" }, "one exact MCP tool"],
    [{ agent_call: { tool: "Bash", args: { command: "shopify store execute" } }, why: "x" }, "one exact MCP tool"],
    [{ agent_call: { tool: "memo.add", args: { text: "x" } }, why: "x" }, "one exact MCP tool"],
    [{ agent_call: { tool: "mcp__installer__memo_add", args: { text: "x" } }, why: "x" }, "TaskFollow's own tools"],
    [{ agent_call: { tool: TOOL, args: ARGS }, tool: "memo.add", why: "x" }, "either tool or agent_call"],
    [{ agent_call: { tool: TOOL, args: ARGS } }, "why"],
  ])("refuses %j", (approve, message) => {
    expect(() => withStep(approve)).toThrow(message);
  });

  it("asks the decision maker to approve exactly that call, and waits", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home));
    expect(run).toMatchObject({ status: "waiting", waiting_on: 1 });
    const item = await getApproval(home, 1, AT);
    expect(item).toMatchObject({
      level: "L3", required_role: "decision_maker", status: "pending", why: "Publish the new product as drafted",
      action: { tool: TOOL, args: ARGS }, expected_values: {}, action_hash: actionHash(TOOL, ARGS, {}),
      source: { via: "runner", run: { workflow: "new-product", run_id: run.run_id, step: "publish" } },
    });
    expect(item.preview).toContain(TOOL);
    expect(await agentRan()).toBe(false);
  });

  it("fails the run before asking when the arguments are not an object, or too large", async () => {
    for (const args of ["${run.id}", { notes: "x".repeat(21_000) }]) {
      const home = await runnerHome();
      const run = await startRun(request(home, withStep({ agent_call: { tool: TOOL, args }, why: "x" })));
      expect(run).toMatchObject({ status: "failed" });
      expect(await listApprovals(home, AT)).toEqual([]);
    }
  });

  it("is skipped in a dry run: nothing is asked and the agent is not started", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home, workflow(), { sandbox: true }));
    expect(run).toMatchObject({ status: "completed" });
    expect(await loadStep(home, run, "publish")).toMatchObject({ status: "done", output: null, skipped: true });
    expect(await listApprovals(home, AT)).toEqual([]);
    expect(await agentRan()).toBe(false);
  });

  it("keeps waiting while the approval is open", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home));
    expect(await resumeRun(request(home), run)).toMatchObject({ status: "waiting", waiting_on: 1 });
  });
});

describe("making the approved call (D151)", () => {
  const OWNER = { name: "Owner", role: "decision_maker" as const };
  const LATER = "2026-10-15T12:05:00.000Z";
  const script = (calls: unknown[], answer: unknown = { done: true }) => vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls, answer }));
  const exact = { tool: TOOL, input: ARGS, response: { content: [{ type: "text", text: "updated" }] } };
  const taskRun = async () => JSON.parse(await readFile(join(agentHome, "task-run.json"), "utf8")) as { args: string[]; denied: string[] };
  const recordLines = async (home: string, run: { workflow: string; run_id: string }) =>
    (await readFile(join(home, "runs", run.workflow, run.run_id, "publish.calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; outcome?: string });

  async function approved(calls: unknown[]) {
    const home = await runnerHome();
    const run = await startRun(request(home));
    await approveItem(home, 1, OWNER, LATER);
    script(calls);
    return { home, run, done: await resumeRun(request(home, workflow(), { now: () => LATER }), run) };
  }

  it("runs the agent, which may make exactly that call once; the approval is used", async () => {
    const { home, run, done } = await approved([exact]);
    expect(done).toMatchObject({ status: "completed" });
    expect((await getApproval(home, 1, LATER)).status).toBe("used");
    expect((await taskRun()).denied).toEqual([]);
    expect(await recordLines(home, run)).toEqual([expect.objectContaining({ tool: TOOL, outcome: "ok" })]);
    expect(await loadStep(home, run, "publish")).toMatchObject({ status: "done", approval: 1 });
  });

  it("refuses changed arguments and a second call; only the approved one runs", async () => {
    const { home, run, done } = await approved([{ ...exact, input: { ...ARGS, title: "Red mug" } }, exact, exact]);
    expect(done).toMatchObject({ status: "completed" });
    expect((await taskRun()).denied).toEqual([TOOL, TOOL]);
    expect((await recordLines(home, run)).map((line) => line.outcome)).toEqual(["refused", "ok", "refused"]);
  });

  it("fails, and does not try again, when the agent did not make the call", async () => {
    const { home, done } = await approved([]);
    expect(done).toMatchObject({ status: "failed", reason: expect.stringContaining("did not make the approved call") });
    expect(done.reason).toContain("run the workflow again");
    expect((await getApproval(home, 1, LATER)).status).toBe("used");
  });

  it("fails when the tool answered with an error", async () => {
    const { done } = await approved([{ ...exact, response: { isError: true, content: [{ type: "text", text: "Product not found" }] } }]);
    expect(done).toMatchObject({ status: "failed", reason: expect.stringContaining(`the approved call to ${TOOL} failed`) });
    expect((await taskRun()).denied).toEqual([]);
  });

  it("keeps the approval when the agent cannot run the call (too old), so nothing is spent for nothing", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home));
    await approveItem(home, 1, OWNER, LATER);
    const { loadState, saveState } = await import("../../src/core/state.js");
    const state = await loadState(home);
    if (!state?.runtime) throw new Error("no runtime");
    await saveState(home, { ...state, runtime: { ...state.runtime, agent_version: "8.0.0" } });
    script([exact]);
    expect(await resumeRun(request(home, workflow(), { now: () => LATER }), run)).toMatchObject({ status: "failed", reason: expect.stringContaining("older than") });
    expect((await getApproval(home, 1, LATER)).status).toBe("approved");
    expect(await agentRan()).toBe(false);
  });

  it("never starts the agent when the call is rejected", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home));
    const { rejectItem } = await import("../../src/core/approvals.js");
    await rejectItem(home, 1, OWNER, "wrong price", LATER);
    expect(await resumeRun(request(home, workflow(), { now: () => LATER }), run)).toMatchObject({ status: "partial", reason: expect.stringContaining("rejected") });
    expect(await agentRan()).toBe(false);
  });

  it("after a crash while the agent ran, stops for a person instead of asking again or calling twice", async () => {
    const home = await runnerHome();
    const run = await startRun(request(home));
    await approveItem(home, 1, OWNER, LATER);
    const { saveStep } = await import("../../src/core/runs.js");
    const { TASK_INTERRUPTED } = await import("../../src/core/task-step.js");
    await saveStep(home, run, { step: "publish", status: "failed", started_at: AT, finished_at: AT, duration_ms: 0, input_fingerprint: "x", approval: 1, error: TASK_INTERRUPTED });
    script([exact]);
    expect(await resumeRun(request(home, workflow(), { now: () => LATER }), run)).toMatchObject({ status: "failed", reason: expect.stringContaining("may already have acted") });
    expect(await listApprovals(home, LATER)).toHaveLength(1);
    expect(await agentRan()).toBe(false);
  });
});

describe("an approved agent call cannot be edited (D151)", () => {
  const changed = JSON.stringify({ ...ARGS, title: "Text with a new title" });

  it("is refused in plain words at the terminal and changes nothing", async () => {
    const home = await runnerHome();
    await startRun(request(home));
    const { approvalsCommand } = await import("../../src/core/approval-commands.js");
    await expect(approvalsCommand(home, { decision_maker: "Owner" }, { sub: "edit", id: "1", value: changed, as: "Owner", interactive: true }, () => AT)).rejects.toThrow("cannot be edited");
    expect((await getApproval(home, 1, AT))).toMatchObject({ status: "pending", action: { args: ARGS } });
  });

  it("is not offered for editing in a chat, and an edit code is refused there", async () => {
    const home = await runnerHome();
    await startRun(request(home));
    const item = await getApproval(home, 1, AT);
    const { announcement, decideByReply } = await import("../../src/core/reply-codes.js");
    expect(announcement({ ...item, action: { ...item.action, args: { ...ARGS, text: "a field called text" } } })).not.toContain("E1");
    const { toolContext } = await import("../../src/core/tools.js");
    const member = { id: 1, name: "Owner", role: "decision_maker" as const, code_hash: "", created_at: AT, expires_at: AT, status: "joined" as const };
    const answer = await decideByReply(await toolContext(home, "gateway", DEFAULT_TOOLS, () => AT), member, { decision: "edit", id: 1, text: "new text" });
    expect(answer).toContain("cannot be edited");
    expect((await getApproval(home, 1, AT)).status).toBe("pending");
  });
});
