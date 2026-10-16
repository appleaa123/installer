import { join } from "node:path";
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

describe("taskfollow why shows a suggestion no channel delivered, once (D164)", () => {
  it("lists it in the run list and in the plain lines, then not again", async () => {
    const { writeConfig } = await import("../../src/core/data-source.js");
    const { NOTICE_FILE } = await import("../../src/core/watch-notice.js");
    const { renderWhy } = await import("../../src/core/why.js");
    const home = await runnerHome();
    await writeConfig(home, NOTICE_FILE, { checked: "2026-10-14", suggested: ["mcp:shopify"], waiting: [{ at: AT, text: "I noticed your agent used shopify on 6 of the last 28 days." }] });
    const first = await whyCommand(home, undefined, () => LATER);
    expect(first.suggestions).toEqual([{ at: AT, text: "I noticed your agent used shopify on 6 of the last 28 days." }]);
    expect(renderWhy(first)).toContain("I noticed your agent used shopify");
    const again = await whyCommand(home, undefined, () => LATER);
    expect(again).not.toHaveProperty("suggestions");
  });

  it("still lists the runs when the suggestion file is damaged, and says how to fix it", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { renderWhy } = await import("../../src/core/why.js");
    const home = await runnerHome();
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "watch-notice.json"), "{ not json");
    const listed = await whyCommand(home, undefined, () => LATER);
    expect(listed).toHaveProperty("runs");
    expect(listed.suggestions_damaged).toContain("config/watch-notice.json is not valid JSON");
    expect(renderWhy(listed)).toContain("config/watch-notice.json is not valid JSON");
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

describe("taskfollow why: each run's result (9.12 item 3, level 1)", () => {
  const run = async (home: string, value: Record<string, unknown>, at: string) =>
    startRun({ home, workflow: parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS), key: `${String(value.workflow)}:${at}`, trigger: { kind: "manual" }, now: () => at });
  const listed = async (home: string) => (await whyCommand(home, "2026-10-14", () => LATER)).runs as { workflow: string; result?: string; status: string }[];

  it("shows an agentic run's summary and a typed run's last output", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "Two memos need you today." }]));
    await run(home, { workflow: "digest", version: 1, mode: "agentic", trigger: { manual: true }, instructions: "Read the memos.", tools: ["memo.list"] }, AT);
    await run(home, { workflow: "list", version: 1, trigger: { manual: true }, steps: [{ id: "memos", tool: "memo.list" }] }, LATER);
    const runs = await listed(home);
    expect(runs.find((entry) => entry.workflow === "digest")?.result).toBe("Two memos need you today.");
    expect(runs.find((entry) => entry.workflow === "list")?.result).toBe('{"memos":[]}');
  });

  it("why list marks a cut result and names the run (item 5)", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "x".repeat(400) }]));
    const record = await run(home, { workflow: "digest", version: 1, mode: "agentic", trigger: { manual: true }, instructions: "Read.", tools: ["memo.list"] }, AT);
    const result = (await listed(home))[0]?.result ?? "";
    expect(result).toBe(`${"x".repeat(299)}… (the whole result: taskfollow why ${record.run_id})`);
  });

  it("why run id shows the whole result when it is a summary (item 5)", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "y".repeat(400) }]));
    const record = await run(home, { workflow: "digest", version: 1, mode: "agentic", trigger: { manual: true }, instructions: "Read.", tools: ["memo.list"] }, AT);
    const why = await whyCommand(home, record.run_id, () => LATER);
    expect(why.result).toBe("y".repeat(400));
    const { renderWhy } = await import("../../src/core/why.js");
    expect(renderWhy(why)).toContain(`result:\n${"y".repeat(400)}`);
  });

  it("why run id shows no message bodies when the run made no list (item 5)", async () => {
    const home = await runnerHome();
    const tool = await toolContext(home, "cli", DEFAULT_TOOLS, () => AT);
    await invokeTool(tool, "memo.add", { text: `first ${"a".repeat(300)}` });
    await invokeTool(tool, "memo.add", { text: "SECOND-MEMO-BODY" });
    const record = await run(home, { workflow: "list", version: 1, trigger: { manual: true }, steps: [{ id: "memos", tool: "memo.list" }] }, AT);
    const why = await whyCommand(home, record.run_id, () => LATER);
    expect(String(why.result)).toContain("this run made no list");
    expect(String(why.result)).not.toContain("SECOND-MEMO-BODY");
  });

  it("why run id of a run without a result is unchanged (item 5)", async () => {
    const home = await runnerHome();
    const record = await run(home, { workflow: "edit", version: 1, trigger: { manual: true }, steps: [{ id: "fix", tool: "memo.edit", args: { id: 99, text: "x" } }] }, AT);
    expect(await whyCommand(home, record.run_id, () => LATER)).not.toHaveProperty("result");
  });

  it("shows no result, and does not fail, when a step file is damaged", async () => {
    const home = await runnerHome();
    const record = await run(home, { workflow: "list", version: 1, trigger: { manual: true }, steps: [{ id: "memos", tool: "memo.list" }] }, AT);
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await writeFile(join(home, "runs", "list", record.run_id, "steps", "memos.json"), "{");
    const runs = await listed(home);
    expect(runs[0]).toMatchObject({ workflow: "list" });
    expect(runs[0]).not.toHaveProperty("result");
  });

  it("says nobody was told about a failed run when no channel exists", async () => {
    const home = await runnerHome();
    await run(home, { workflow: "edit", version: 1, trigger: { manual: true }, steps: [{ id: "fix", tool: "memo.edit", args: { id: 99, text: "x" } }] }, AT);
    const { renderWhy } = await import("../../src/core/why.js");
    const text = renderWhy(await whyCommand(home, "2026-10-14", () => LATER));
    expect(text).toContain("(nobody was told: no channel)");
    expect(text).toMatch(/result: |failed/);
  });

  it("still says nobody was told when the only channel is WhatsApp, which reaches customers (PR #45 review)", async () => {
    const home = await runnerHome();
    const { saveChannel } = await import("../../src/core/channels.js");
    await saveChannel(home, { channel: "whatsapp", relay_url: "https://relay.example.com", phone_number_id: "1", display_number: "+1 555 0100", verified_at: AT });
    await run(home, { workflow: "edit", version: 1, trigger: { manual: true }, steps: [{ id: "fix", tool: "memo.edit", args: { id: 99, text: "x" } }] }, AT);
    expect(await whyCommand(home, "2026-10-14", () => LATER)).toMatchObject({ no_channel: true });
    await saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: AT });
    expect(await whyCommand(home, "2026-10-14", () => LATER)).toMatchObject({ no_channel: false });
  });
});

