import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASON_TOOL } from "../../src/core/agent-hook.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { resumeRun, startRun, type RunRequest } from "../../src/core/runner.js";
import { claimRun, loadStep, runIdFor, saveStep, type RunRecord } from "../../src/core/runs.js";
import { loadState, saveState } from "../../src/core/state.js";
import { TASK_INTERRUPTED } from "../../src/core/task-step.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-14T12:00:00.000Z";
const KEY = `order-status:${AT}`;
const OUTPUT = { type: "object", properties: { order_found: { type: "boolean" }, status: { type: "string" } }, required: ["order_found"], additionalProperties: false };
const LOOKUP = { id: "lookup", task: { prompt: "Find the order of this customer and say its status.", input: { email: "sam@example.com" }, may_use: ["mcp__shopify__get_order"], output: OUTPUT } };
const WORKFLOW = { workflow: "order-status", version: 1, description: "Looks up an order", trigger: { manual: true }, steps: [LOOKUP] };

let agentHome = "";
beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});
afterEach(() => vi.unstubAllEnvs());

const script = (answer: unknown, calls: unknown[] = [{ tool: "mcp__shopify__get_order", input: { email: "sam@example.com" }, response: { status: "shipped" } }]) =>
  vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls, answer }));
const workflow = (value: Record<string, unknown> = WORKFLOW) => parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS);
const request = (home: string, wf = workflow(), extra: Partial<RunRequest> = {}): RunRequest => ({ home, workflow: wf, key: KEY, trigger: { kind: "manual" }, now: () => AT, ...extra });
const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const agentRan = async () => readFile(join(agentHome, "task-run.json"), "utf8").then(() => true, () => false);

describe("the task step in a workflow (D139)", () => {
  const parse = (task: Record<string, unknown>) => () => workflow({ ...WORKFLOW, steps: [{ id: "lookup", task: { ...LOOKUP.task, ...task } }] });

  it("reads a task step with its prompt, input, tools, output and time limit", () => {
    const step = workflow({ ...WORKFLOW, steps: [{ id: "lookup", task: { ...LOOKUP.task, changes: false, timeout_minutes: 5 } }] }).steps[0];
    expect(step).toMatchObject({ kind: "task", task: { prompt: LOOKUP.task.prompt, may_use: ["mcp__shopify__get_order"], changes: false, timeout_minutes: 5 } });
  });

  it.each([
    [{ may_use: [] }, "may_use"],
    [{ may_use: ["Bash"] }, "Bash(...)"],
    [{ may_use: ["*"] }, "may_use"],
    [{ may_use: ["mcp__installer__memo_add"] }, "TaskFollow's own tools"],
    [{ prompt: "" }, "prompt"],
    [{ output: { type: "nonsense" } }, "output"],
    [{ timeout_minutes: 0 }, "timeout_minutes"],
    [{ timeout_minutes: 31 }, "timeout_minutes"],
    [{ changes: "yes" }, "changes"],
  ])("refuses a task step with %j", (task, message) => {
    expect(parse(task)).toThrow(message);
  });

  it("refuses a reference to a step that has not run yet", () => {
    expect(parse({ input: { order: "${later.id}" } })).toThrow("later");
  });
});

describe("running a task step (D139)", () => {
  it("hands the task to the agent, keeps its answer as the step's output, and seals the record of its calls", async () => {
    const home = await runnerHome();
    script({ order_found: true, status: "shipped" }, [
      { tool: REASON_TOOL, input: { tool: "mcp__shopify__get_order", why: "the customer asks about their order" } },
      { tool: "mcp__shopify__get_order", input: { email: "sam@example.com" }, response: { status: "shipped" } },
    ]);
    const run = await startRun(request(home));
    expect(run).toMatchObject({ status: "completed" });
    expect(await loadStep(home, run, "lookup")).toMatchObject({ status: "done", output: { order_found: true, status: "shipped" } });
    const record = await readFile(join(home, "runs", "order-status", run.run_id, "lookup.calls.jsonl"), "utf8");
    expect(record).toContain("mcp__shopify__get_order");
    expect(await events(home)).toContain("run.task_calls");
  });

  it("fails the run in plain words when the answer does not fit the step's output", async () => {
    const home = await runnerHome();
    script({ order_found: "maybe" });
    const run = await startRun(request(home));
    expect(run).toMatchObject({ status: "failed", reason: expect.stringContaining("order_found") });
  });

  it("does not run a task again after a crash in the middle of it, because it may already have acted", async () => {
    const home = await runnerHome();
    script({ order_found: true });
    const record: RunRecord = { workflow: "order-status", run_id: runIdFor(KEY, AT), key: KEY, status: "running", trigger: { kind: "manual" }, version: 1, pid: 0, started_at: AT, actions: 0, needs_human: 0, sandbox: false };
    await claimRun(home, record);
    await saveStep(home, record, { step: "lookup", status: "failed", started_at: AT, finished_at: AT, duration_ms: 0, input_fingerprint: "x", error: TASK_INTERRUPTED });
    const run = await resumeRun(request(home), record);
    expect(run).toMatchObject({ status: "failed", reason: expect.stringContaining("may already have acted") });
    expect(run.reason).toContain("'taskfollow why ");
    expect(run.reason).not.toContain("--run");
    expect(await agentRan()).toBe(false);
  });

  it("in a dry run, runs a read-only task but never a task that may change things", async () => {
    const home = await runnerHome();
    script({ order_found: true });
    const readOnly = await startRun(request(home, workflow(), { sandbox: true }));
    expect(await loadStep(home, readOnly, "lookup")).toMatchObject({ status: "done", output: { order_found: true } });
    const changing = workflow({ ...WORKFLOW, workflow: "order-fix", steps: [{ id: "fix", task: { ...LOOKUP.task, changes: true, may_use: ["mcp__shopify__update_order"] } }] });
    const home2 = await runnerHome();
    const run = await startRun({ ...request(home2, changing, { sandbox: true }), key: `order-fix:${AT}` });
    expect(await loadStep(home2, run, "fix")).toMatchObject({ status: "done", output: null, skipped: true });
  });

  it("fails the run before the agent starts when the agent is older than task steps need", async () => {
    const home = await runnerHome();
    const state = await loadState(home);
    if (!state?.runtime) throw new Error("no runtime");
    await saveState(home, { ...state, runtime: { ...state.runtime, agent_version: "8.0.0" } });
    script({ order_found: true });
    const run = await startRun(request(home));
    expect(run).toMatchObject({ status: "failed", reason: expect.stringContaining("older than 9.0.0") });
    expect(await agentRan()).toBe(false);
  });

  it("fails the run in plain words when the person's agent cannot run task steps", async () => {
    const home = await runnerHome();
    const state = await loadState(home);
    if (!state?.runtime) throw new Error("no runtime");
    await saveState(home, { ...state, runtime: { ...state.runtime, profile: "fake-codex" } });
    script({ order_found: true });
    const run = await startRun(request(home));
    expect(run).toMatchObject({ status: "failed", reason: expect.stringContaining("cannot run task steps yet") });
  });
});
