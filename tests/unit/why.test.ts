import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASON_TOOL } from "../../src/core/agent-hook.js";
import { approveItem } from "../../src/core/approvals.js";
import { resumeRun, startRun, type RunRequest } from "../../src/core/runner.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { whyCommand } from "../../src/core/why.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-14T12:00:00.000Z";
const LATER = "2026-10-14T12:05:00.000Z";
const OUTPUT = { type: "object", properties: { order_found: { type: "boolean" }, status: { type: "string" } }, required: ["order_found"] };
const WORKFLOW = {
  workflow: "order-status", version: 1, description: "Looks up an order and notes it", trigger: { manual: true },
  steps: [
    { id: "lookup", task: { prompt: "Find the order and say its status.", input: { email: "sam@example.com" }, may_use: ["mcp__shopify__get_order"], output: OUTPUT } },
    { id: "note", approve: { tool: "memo.edit", args: { id: 1, text: "Order status: ${lookup.status}" }, why: "Keep a note of the order's status for the team" } },
  ],
};
const workflow = () => parseWorkflow(WORKFLOW, "order-status", DEFAULT_TOOLS);
const request = (home: string, now = AT): RunRequest => ({ home, workflow: workflow(), key: `order-status:${AT}`, trigger: { kind: "manual" }, now: () => now });

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

async function finishedRun() {
  const home = await runnerHome();
  await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "Order status: unknown" });
  vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({
    calls: [
      { tool: REASON_TOOL, input: { tool: "mcp__shopify__get_order", why: "the customer asks where their order is" } },
      { tool: "mcp__shopify__get_order", input: { email: "sam@example.com" }, response: { status: "shipped" } },
      { tool: "mcp__shopify__create_refund", input: { order: 1001 } },
    ],
    answer: { order_found: true, status: "shipped" },
  }));
  const waiting = await startRun(request(home));
  await approveItem(home, 1, { name: "Owner", role: "decision_maker" }, LATER);
  const run = await resumeRun(request(home, LATER), waiting);
  return { home, run };
}

describe("taskfollow why (D138)", () => {
  it("explains one run step by step: who did what, and why", async () => {
    const { home, run } = await finishedRun();
    expect(run.status).toBe("completed");
    const why = (await whyCommand(home, run.run_id, () => LATER)) as { run: Record<string, unknown>; timeline: { who: string; what: string; why: string }[] };
    expect(why.run).toMatchObject({ workflow: "order-status", run_id: run.run_id, status: "completed" });
    const lines = why.timeline.map((entry) => `${entry.who} | ${entry.what} | ${entry.why}`);
    expect(lines[0]).toMatch(/^TaskFollow \| started the run/);
    expect(lines).toContainEqual(expect.stringMatching(/^your agent \| mcp__shopify__get_order .*\| the customer asks where their order is$/));
    expect(lines).toContainEqual(expect.stringMatching(/^TaskFollow \| refused mcp__shopify__create_refund .*\| This step may only use: mcp__shopify__get_order/));
    expect(lines).toContainEqual(expect.stringMatching(/^TaskFollow \| asked a person to approve memo\.edit .*\| Keep a note of the order's status for the team$/));
    expect(lines).toContainEqual(expect.stringMatching(/^Owner \| approved memo\.edit/));
    expect(lines.at(-1)).toMatch(/^TaskFollow \| finished the run: completed/);
  });

  it("says plainly when the agent gave no reason for a call", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [{ tool: "mcp__shopify__get_order", input: { id: 1 }, response: {} }], answer: { order_found: false } }));
    const run = await startRun({ ...request(home), workflow: parseWorkflow({ ...WORKFLOW, steps: [WORKFLOW.steps[0]] }, "order-status", DEFAULT_TOOLS) });
    const why = (await whyCommand(home, run.run_id, () => LATER)) as { timeline: { who: string; what: string; why: string }[] };
    expect(why.timeline.find((entry) => entry.what.startsWith("mcp__shopify__get_order"))?.why).toBe("the agent gave no reason");
  });

  it("lists the runs of the last day when no run is named, and the runs since a date", async () => {
    const { home, run } = await finishedRun();
    expect(await whyCommand(home, undefined, () => LATER)).toMatchObject({ runs: [{ run_id: run.run_id, workflow: "order-status", status: "completed" }], next: expect.stringContaining("taskfollow why <run>") });
    expect(await whyCommand(home, "2026-10-15", () => LATER)).toMatchObject({ runs: [] });
    expect(await whyCommand(home, undefined, () => "2026-10-20T00:00:00.000Z")).toMatchObject({ runs: [] });
  });

  it("still lists the other runs when one run record is damaged", async () => {
    const { home, run } = await finishedRun();
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(join(home, "runs", "order-status", "damaged"), { recursive: true });
    await writeFile(join(home, "runs", "order-status", "damaged", "run.json"), "{}");
    expect(await whyCommand(home, undefined, () => LATER)).toMatchObject({ runs: [{ run_id: run.run_id }] });
  });

  it("refuses a run it does not know, in plain words", async () => {
    const home = await runnerHome();
    await expect(whyCommand(home, "2026-10-14-deadbeef", () => LATER)).rejects.toThrow("No run '2026-10-14-deadbeef'");
    await expect(whyCommand(home, "yesterday", () => LATER)).rejects.toThrow("a run id");
  });
});

describe("taskfollow why, as a person reads it", () => {
  it("shows one line per entry with its reason underneath, and one line per run", async () => {
    const { renderWhy } = await import("../../src/core/why.js");
    expect(renderWhy({ run: {}, timeline: [{ at: AT, who: "your agent", what: "mcp__shopify__get_order {}", why: "the customer asked" }] })).toBe("2026-10-14 12:00  your agent: mcp__shopify__get_order {}\n    why: the customer asked");
    expect(renderWhy({ since: AT, runs: [] })).toBe(`No runs since ${AT}.`);
    expect(renderWhy({ since: AT, runs: [{ run_id: "2026-10-14-1a2b3c4d", workflow: "order-status", started_at: AT, status: "failed", reason: "x" }], next: "n" })).toBe("2026-10-14 12:00  2026-10-14-1a2b3c4d  order-status: failed (x)\n\nn");
  });
});
