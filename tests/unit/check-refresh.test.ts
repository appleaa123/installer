import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASON_TOOL } from "../../src/core/agent-hook.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { runnerStopReason } from "../../src/core/check-fresh.js";
import { abilities, recordResult } from "../../src/core/checks.js";
import { startRun } from "../../src/core/runner.js";
import { saveWorkflowState } from "../../src/core/sandbox.js";
import { loadState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Review 4 of PR #54: a successful real run refreshes the runner proof; the stop notice reaches the decision maker at most once a day. */
const DAY0 = "2026-09-01T08:00:00.000Z";
const DAY20 = "2026-09-21T08:00:00.000Z";
const DAY40 = "2026-10-11T08:00:00.000Z";
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

const OUTPUT = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const WF = { workflow: "brief", version: 1, description: "A brief.", trigger: { manual: true }, steps: [{ id: "look", task: { prompt: "Look.", input: {}, may_use: ["mcp__shop__get"], output: OUTPUT } }] };
const workflow = () => parseWorkflow(WF, "brief", DEFAULT_TOOLS);
const script = () => vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [{ tool: REASON_TOOL, input: { tool: "mcp__shop__get", why: "to look" } }, { tool: "mcp__shop__get", input: {}, response: { ok: true } }], answer: { ok: true } }));
const pass = (home: string, need: "runner" | "tools", at: string) => recordResult(home, { need, result: "yes-tested", reason: "tested", at, agent: "fake-agent", agent_version: "9.9.9", test: "t7" });

async function shapedHome(): Promise<string> {
  const home = await runnerHome();
  await saveWorkflowState(home, { workflow: "brief", sandbox: false, described: { description_hash: "x", content_hash: "y", sends_to_others: false, writes_or_deletes: false, at: DAY0 } });
  return home;
}
const run = (home: string, at: string, key: string, sandbox = false) => startRun({ home, workflow: workflow(), key, trigger: { kind: "manual" }, now: () => at, sandbox });

describe("a successful real run refreshes the proof (review 4)", () => {
  it("records runner, and tools when TaskFollow's own tool answered, scoped to the workflow", async () => {
    const home = await shapedHome();
    await pass(home, "runner", DAY0);
    await pass(home, "tools", DAY0);
    script();
    expect(await run(home, DAY20, "brief:a")).toMatchObject({ status: "completed" });
    const refreshed = (await abilities(home)).filter((entry) => entry.test === "run");
    expect(refreshed.map((entry) => [entry.need, entry.workflow, entry.result])).toEqual(expect.arrayContaining([["runner", "brief", "yes-tested"], ["tools", "brief", "yes-tested"]]));
    expect(refreshed[0]?.reason).toContain("a real run through TaskFollow's runner finished on 2026-09-21");
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, DAY40)).toBeNull();
  });

  it("a sandbox run refreshes nothing", async () => {
    const home = await shapedHome();
    script();
    await run(home, DAY20, "brief:b", true);
    expect((await abilities(home)).filter((entry) => entry.test === "run")).toEqual([]);
  });
});

describe("the stop notice (review 4)", () => {
  it("tells the decision maker at most once a day per workflow", async () => {
    const home = await shapedHome();
    await pass(home, "runner", DAY0);
    await pass(home, "tools", DAY0);
    script();
    expect(await run(home, DAY40, "brief:1")).toMatchObject({ status: "failed" });
    expect(await run(home, "2026-10-11T09:00:00.000Z", "brief:2")).toMatchObject({ status: "failed" });
    const escalations = (await readFile(join(home, AUDIT_FILE), "utf8")).split("\n").filter((line) => line.includes('"run.escalated"'));
    expect(escalations).toHaveLength(1);
    expect(await run(home, "2026-10-12T09:00:00.000Z", "brief:3")).toMatchObject({ status: "failed" });
    expect((await readFile(join(home, AUDIT_FILE), "utf8")).split("\n").filter((line) => line.includes('"run.escalated"'))).toHaveLength(2);
  });
});
