import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASON_TOOL } from "../../src/core/agent-hook.js";
import { approveItem } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { setPaused } from "../../src/core/pause.js";
import { resumeRun, startRun, type RunRequest } from "../../src/core/runner.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { NOTICE_FILE } from "../../src/core/watch-notice.js";
import { recordDirectCall } from "../../src/core/watch-record.js";
import { whyCommand } from "../../src/core/why.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-14T12:00:00.000Z";
const LATER = "2026-10-14T12:05:00.000Z";
const SUGGESTION = { at: AT, text: "I noticed your agent used shopify on 6 of the last 28 days." };
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

/** A home with one finished run (a task call, a refused call, an approval) and no waiting suggestion. */
async function finishedRun() {
  const home = await runnerHome();
  await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "Order status: unknown" });
  vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({
    calls: [
      { tool: REASON_TOOL, input: { tool: "mcp__shopify__get_order", why: "the customer asks where their order is" } },
      { tool: "mcp__shopify__get_order", input: { email: "sam@example.com" }, response: { status: "shipped" } },
    ],
    answer: { order_found: true, status: "shipped" },
  }));
  const waiting = await startRun(request(home));
  await approveItem(home, 1, { name: "Owner", role: "decision_maker" }, LATER);
  const run = await resumeRun(request(home, LATER), waiting);
  return { home, run };
}

const show = async (home: string, args: Record<string, unknown>) => invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS, () => LATER), "why.show", args);
const waitSuggestion = (home: string) => writeConfig(home, NOTICE_FILE, { checked: "2026-10-14", suggested: ["mcp:shopify"], waiting: [SUGGESTION] });
const auditLines = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

describe("why.show, the why command as a tool (D169)", () => {
  it("why.show with no argument lists the runs since yesterday, exactly as taskfollow why does", async () => {
    const { home } = await finishedRun();
    const expected = await whyCommand(home, undefined, () => LATER);
    expect(await show(home, {})).toEqual(expected);
  });

  it("why.show with a run id gives that run's timeline, exactly as taskfollow why <run> does", async () => {
    const { home, run } = await finishedRun();
    const expected = await whyCommand(home, run.run_id, () => LATER);
    expect(await show(home, { run: run.run_id })).toEqual(expected);
  });

  it("why.show with since lists the runs since that date", async () => {
    const { home, run } = await finishedRun();
    const expected = await whyCommand(home, "2026-10-13", () => LATER);
    const shown = await show(home, { since: "2026-10-13" });
    expect(shown).toEqual(expected);
    expect((shown.runs as { run_id: string }[]).map((row) => row.run_id)).toEqual([run.run_id]);
  });

  it("why.show with direct gives that day's direct calls, exactly as taskfollow why direct <day> does", async () => {
    const home = await runnerHome();
    await recordDirectCall(home, JSON.stringify({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: { id: 1 } }), ["mcp:shopify"], "2026-10-13T09:00:00.000Z");
    const expected = await whyCommand(home, "direct", () => LATER, "2026-10-13");
    expect(expected.timeline).toHaveLength(1);
    expect(await show(home, { direct: "2026-10-13" })).toEqual(expected);
  });

  it("why.show refuses two of run, since and direct at once", async () => {
    const home = await runnerHome();
    await expect(show(home, { since: "2026-10-13", direct: "2026-10-14" })).rejects.toThrow("why.show takes at most one of run, since, direct");
  });

  it("why.show refuses a date given as run, and clears no suggestion", async () => {
    const home = await runnerHome();
    await waitSuggestion(home);
    await expect(show(home, { run: "2026-10-01" })).rejects.toThrow("why.show: run must be a run id, for example 2026-10-14-1a2b3c4d");
    expect((await whyCommand(home, undefined, () => LATER)).suggestions).toEqual([SUGGESTION]);
  });

  it("why.show refuses a run id given as since, and clears no suggestion", async () => {
    const home = await runnerHome();
    await waitSuggestion(home);
    await expect(show(home, { since: "2026-10-14-1a2b3c4d" })).rejects.toThrow("why.show: since must be a date, for example 2026-10-13");
    expect((await whyCommand(home, undefined, () => LATER)).suggestions).toEqual([SUGGESTION]);
  });

  it("why.show refuses run: \"direct\" and a direct that is no day, and clears no suggestion", async () => {
    const home = await runnerHome();
    await waitSuggestion(home);
    await expect(show(home, { run: "direct" })).rejects.toThrow("why.show: run must be a run id");
    await expect(show(home, { direct: "today" })).rejects.toThrow("why.show: direct must be a day, for example 2026-10-14");
    expect((await whyCommand(home, undefined, () => LATER)).suggestions).toEqual([SUGGESTION]);
  });

  it("why.show puts waiting suggestions first in its answer", async () => {
    const { home } = await finishedRun();
    await waitSuggestion(home);
    const shown = await show(home, {});
    expect(Object.keys(shown)[0]).toBe("suggestions");
    expect(shown.suggestions).toEqual([SUGGESTION]);
  });

  it("why.show puts suggestions first, then rule_candidates (item 8)", async () => {
    const { home } = await finishedRun();
    await waitSuggestion(home);
    const { saveWritten } = await import("../../src/core/workflow-skill.js");
    await saveWritten(home, { skill_folders: [{ workflow: "inbox", path: join(home, "skills", "inbox"), root: join(home, "skills") }] });
    const { requestApproval, rejectItem } = await import("../../src/core/approvals.js");
    const { prepareAgentCall } = await import("../../src/core/agent-call.js");
    const asked = await requestApproval(home, { prepared: prepareAgentCall("reply", "mcp__mail__send", {}), via: "runner", run: { workflow: "inbox", run_id: "r1", step: "reply" }, why: "Reply" }, AT);
    await rejectItem(home, asked.id, { name: "Owner", role: "decision_maker" }, "too formal", AT);
    const shown = await show(home, {});
    expect(Object.keys(shown).slice(0, 2)).toEqual(["suggestions", "rule_candidates"]);
  });

  it("why.show puts a damaged suggestion file's message first too", async () => {
    const { home } = await finishedRun();
    await waitSuggestion(home);
    await writeFile(join(home, NOTICE_FILE), "{ not json");
    const shown = await show(home, {});
    expect(Object.keys(shown)[0]).toBe("suggestions_damaged");
    expect(shown.suggestions_damaged).toContain("config/watch-notice.json is not valid JSON");
  });

  it("a large why.show answer keeps the suggestions whole when a client cuts it from the end", async () => {
    const home = await runnerHome();
    const memo = parseWorkflow({ workflow: "notes", version: 1, description: "Lists the notes", trigger: { manual: true }, steps: [{ id: "read", tool: "memo.list", args: {} }] }, "notes", DEFAULT_TOOLS);
    for (let index = 0; index < 60; index += 1) {
      await startRun({ home, workflow: memo, key: `notes:${index}`, trigger: { kind: "manual" }, now: () => AT });
    }
    await waitSuggestion(home);
    const text = JSON.stringify(await show(home, {}));
    // A client that cuts a long answer keeps its start: here the first 400 characters already hold the whole suggestion.
    expect(text.length).toBeGreaterThan(5_000);
    expect(text.slice(0, 400)).toContain(SUGGESTION.text);
  });

  it("why.show refuses a key it does not take", async () => {
    const home = await runnerHome();
    await expect(show(home, { day: "2026-10-14" })).rejects.toThrow("why.show does not take 'day'");
  });

  it("why.show refuses a run that does not exist with why's own message", async () => {
    const home = await runnerHome();
    await expect(show(home, { run: "2026-10-14-1a2b3c4d" })).rejects.toThrow("No run '2026-10-14-1a2b3c4d'");
  });

  it("why.show shows a waiting I-noticed suggestion once, then not again, and audits it as shown (D164)", async () => {
    const home = await runnerHome();
    await waitSuggestion(home);
    expect((await show(home, {})).suggestions).toEqual([SUGGESTION]);
    expect(await show(home, {})).not.toHaveProperty("suggestions");
    expect((await auditLines(home)).filter((line) => line.includes("watch.noticed_shown"))).toHaveLength(1);
  });

  it("why.show runs while TaskFollow is paused, and takes no approval token", async () => {
    const home = await runnerHome();
    await setPaused(home, true, { name: "Owner", actor: "human", via: "terminal" }, AT);
    await expect(show(home, {})).resolves.toHaveProperty("runs");
    await expect(show(home, { approval_token: "x" })).rejects.toThrow("why.show takes no approval_token");
  });

  it("why.show writes nothing to the audit log of its own, except D164's shown-suggestions line", async () => {
    // Item 8 (D173): the list form also keeps corrections as rule candidates (and audits rules.candidate); this
    // fixture's approval was approved, not edited or rejected, and no skill folder is recorded, so nothing is kept.
    const { home, run } = await finishedRun();
    const before = await auditLines(home);
    await show(home, {});
    await show(home, { run: run.run_id });
    await show(home, { direct: "2026-10-14" });
    expect(await auditLines(home)).toEqual(before);
    await waitSuggestion(home);
    await show(home, {});
    const added = (await auditLines(home)).slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain("watch.noticed_shown");
  });

  it("no workflow can use why.show: a tool step, an approve step and an agent step's tools are refused", () => {
    const steps = [
      { id: "a", tool: "why.show", args: {} },
      { id: "a", approve: { tool: "why.show", args: {}, why: "x" } },
      { id: "a", agent: { instructions: "x", tools: ["why.show"] } },
    ];
    for (const step of steps) {
      expect(() => parseWorkflow({ workflow: "w", version: 1, description: "x", trigger: { manual: true }, steps: [step] }, "w", DEFAULT_TOOLS)).toThrow("why.show is approval bookkeeping");
    }
  });

  it("no workflow can list mcp__installer__why_show in a task's may_use", () => {
    const step = { id: "a", task: { prompt: "x", may_use: ["mcp__installer__why_show"], output: OUTPUT } };
    expect(() => parseWorkflow({ workflow: "w", version: 1, description: "x", trigger: { manual: true }, steps: [step] }, "w", DEFAULT_TOOLS)).toThrow("TaskFollow's own tools are used through tool and approve steps");
  });
});
