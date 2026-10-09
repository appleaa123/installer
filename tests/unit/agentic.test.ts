import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveItem, listApprovals, rejectItem } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { UNTRUSTED_FENCE } from "../../src/core/judge.js";
import { resumeRun, startRun } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
let agentHome = "";
beforeEach(async () => {
  agentHome = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agentHome);
});
afterEach(() => vi.unstubAllEnvs());

const answers = (...values: unknown[]) => vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(values));
const prompts = async () => (await readFile(join(agentHome, "judge-calls.jsonl"), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { prompt: string }).prompt);
const AGENTIC = { workflow: "tidy", version: 1, mode: "agentic", instructions: "Read the memos and add one memo that counts them.", tools: ["memo.list", "memo.add", "memo.edit"] };
const parse = (value: Record<string, unknown>) => parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS);
const start = (home: string, value: Record<string, unknown> = AGENTIC, sandbox = false) =>
  startRun({ home, workflow: parse(value), key: `${String(value.workflow)}:${AT}`, trigger: { kind: "manual" }, now: () => AT, sandbox });
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const addMemo = async (home: string, text: string) => invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text });
const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("agentic workflows (§10.8, D92)", () => {
  it("are one agent step with the tools the workflow names", () => {
    const workflow = parse(AGENTIC);
    expect(workflow).toMatchObject({ mode: "agentic", steps: [{ id: "agent", kind: "agent", agent: { tools: ["memo.list", "memo.add", "memo.edit"], max_turns: 8 } }] });
  });

  it.each([
    [{ ...AGENTIC, tools: ["memo.nope"] }, "names no known tool"],
    [{ ...AGENTIC, tools: ["approvals.request"] }, "approval bookkeeping"],
    [{ ...AGENTIC, tools: [] }, "must list the tools"],
    [{ ...AGENTIC, max_turns: 21 }, "max_turns must be a whole number from 1 to 20"],
    [{ ...AGENTIC, steps: [{ id: "a", tool: "memo.list" }] }, "not steps or a fallback"],
    [{ workflow: "tidy", version: 1, steps: [{ id: "a", foreach: "${run.key}", agent: { instructions: "x", tools: ["memo.list"] } }] }, "cannot use foreach"],
  ])("refuses %j", (value, message) => {
    expect(() => parse(value)).toThrow(message);
  });

  it("lets the agent choose each call; the runner makes it and logs every turn", async () => {
    const home = await runnerHome();
    await addMemo(home, "One");
    answers({ tool: "memo.list", args: {} }, { tool: "memo.add", args: { text: "There is 1 memo" } }, { tool: "done", summary: "Counted the memos" });
    const run = await start(home);
    expect(run).toMatchObject({ status: "completed", actions: 1, needs_human: 0 });
    expect(await memos(home)).toEqual(["One", "There is 1 memo"]);
    const log = await loadStep(home, run, "agent");
    expect(log).toMatchObject({ status: "done", output: { summary: "Counted the memos", calls: 2 } });
    expect(log?.turns).toMatchObject([{ tool: "memo.list", level: "L0", result: { memos: [{ text: "One" }] } }, { tool: "memo.add", args: { text: "There is 1 memo" }, level: "L1" }]);
    const last = (await prompts()).at(-1) ?? "";
    expect(last).toContain(UNTRUSTED_FENCE);
    expect(last).toContain('"name":"memo.edit"');
    expect(last).toContain("Calls left: 6");
  });

  it("waits for a person at an L2 call, then makes exactly that call and lets the agent finish", async () => {
    const home = await runnerHome();
    await addMemo(home, "Old");
    answers({ tool: "memo.edit", args: { id: 1, text: "New" } }, { tool: "done", summary: "Edited" });
    const waiting = await start(home);
    expect(waiting).toMatchObject({ status: "waiting", waiting_on: 1 });
    expect((await listApprovals(home, AT))[0]).toMatchObject({ why: "Workflow 'tidy' (agentic step 'agent', call 1) wants to run memo.edit, which is L2", source: { run: { step: "agent" } } });
    await approveItem(home, 1, { name: "Ada", role: "member" }, AT);
    const done = await resumeRun({ home, workflow: parse(AGENTIC), key: waiting.key, trigger: waiting.trigger, now: () => AT }, waiting);
    expect(done).toMatchObject({ status: "completed", actions: 1 });
    expect(await memos(home)).toEqual(["New"]);
  });

  it("tells the agent a person rejected its call, and the agent goes on", async () => {
    const home = await runnerHome();
    await addMemo(home, "Old");
    answers({ tool: "memo.edit", args: { id: 1, text: "New" } }, { tool: "done", summary: "Left it" });
    const waiting = await start(home);
    await rejectItem(home, 1, { name: "Ada", role: "member" }, "keep it", AT);
    const done = await resumeRun({ home, workflow: parse(AGENTIC), key: waiting.key, trigger: waiting.trigger, now: () => AT }, waiting);
    expect(done).toMatchObject({ status: "completed", actions: 0 });
    expect((await prompts()).at(-1)).toContain("a person rejected this call: keep it");
    expect(await memos(home)).toEqual(["Old"]);
  });

  it("never uses a token or a level the model wrote: both come back to it as errors (R8)", async () => {
    const home = await runnerHome();
    await addMemo(home, "Old");
    answers({ tool: "memo.edit", args: { id: 1, text: "x", approval_token: "1.".padEnd(66, "a") } }, { tool: "memo.add", args: { text: "x", level: "L0" } }, { tool: "done", summary: "Gave up" });
    const run = await start(home);
    expect((await loadStep(home, run, "agent"))?.turns).toEqual([
      { tool: "memo.edit", args: { id: 1, text: "x" }, error: "approval_token came from the model; only the runner passes tokens (R8)" },
      { tool: "memo.add", args: { text: "x", level: "L0" }, error: "memo.add does not take 'level'; it takes text" },
    ]);
    expect(await listApprovals(home, AT)).toEqual([]);
    expect(await memos(home)).toEqual(["Old"]);
  });

  it("needs a person when the answer names a tool it may not use, twice", async () => {
    const home = await runnerHome();
    answers({ tool: "memo.delete", args: { id: 1 } });
    const run = await start(home);
    expect(run).toMatchObject({ status: "partial", needs_human: 1 });
    expect(await loadStep(home, run, "agent")).toMatchObject({ output: null, needs_human: [{ reason: expect.stringContaining("did not fit twice") }] });
  });

  it("stops at the call budget", async () => {
    const home = await runnerHome();
    answers({ tool: "memo.list", args: {} });
    const run = await start(home, { ...AGENTIC, max_turns: 2 });
    expect(run).toMatchObject({ status: "partial", needs_human: 1 });
    expect(await loadStep(home, run, "agent")).toMatchObject({ needs_human: [{ reason: "the agent did not finish within 2 calls" }] });
  });

  it("records every action in a sandbox run and asks no approval", async () => {
    const home = await runnerHome();
    await addMemo(home, "Old");
    answers({ tool: "memo.edit", args: { id: 1, text: "New" } }, { tool: "done", summary: "Edited" });
    expect(await start(home, AGENTIC, true)).toMatchObject({ status: "completed", sandbox: true });
    expect(await listApprovals(home, AT)).toEqual([]);
    expect(await memos(home)).toEqual(["Old"]);
  });
});

describe("drift: a typed run falls back to the workflow's agent (D18)", () => {
  const TYPED = {
    workflow: "fix", version: 2, steps: [{ id: "first", tool: "memo.add", args: { text: "first" } }, { id: "broken", tool: "memo.edit", args: { id: 99, text: "x" } }, { id: "never", tool: "memo.add", args: { text: "never" } }],
    fallback: { instructions: "Finish the job the failed step could not do.", tools: ["memo.add"] },
  };

  it("keeps the steps done before the failure, lets the agent finish, and tells the decision maker", async () => {
    const home = await runnerHome();
    answers({ tool: "memo.add", args: { text: "agent finished" } }, { tool: "done", summary: "Finished" });
    const run = await start(home, TYPED);
    expect(run).toMatchObject({ status: "completed", fallback_from: { step: "broken", error: "step 'broken' failed: No memo 99" } });
    expect(await memos(home)).toEqual(["first", "agent finished"]);
    expect(await events(home)).toEqual(expect.arrayContaining(["run.fallback", "run.escalated"]));
    expect((await prompts())[0]).toContain('"failure": {');
  });

  it("does not fall back when the workflow has no agent", async () => {
    const home = await runnerHome();
    const { fallback: _none, ...plain } = TYPED;
    expect(await start(home, plain)).toMatchObject({ status: "failed", reason: "step 'broken' failed: No memo 99" });
  });
});
