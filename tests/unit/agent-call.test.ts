import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionHash, getApproval, listApprovals } from "../../src/core/approvals.js";
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
