import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAction, runCheck } from "../../src/core/actions.js";
import { writeConfig } from "../../src/core/data-source.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { ActionFailure } from "../../src/core/failure.js";
import { storeInbound, type Route } from "../../src/core/inbox.js";
import { InputError } from "../../src/core/inputs.js";
import { dryrunCommand, workflowCommand } from "../../src/core/lifecycle.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadWorkflowState, sandboxMode } from "../../src/core/sandbox.js";
import { HEARTBEAT_FILE } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { MEMO_DIGEST, writeWorkflow } from "../helpers/workflow-home.js";
import { loadState, saveState } from "../../src/core/state.js";
import { loadWorkflow, workflowIds } from "../../src/core/workflow.js";

const AT = "2026-10-08T12:00:00.000Z";
const NOTE = { workflow: "note", description: "Adds a memo each weekday morning", trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, steps: [{ id: "add", tool: "memo.add", args: { text: "Good morning" } }] };
const SOLUTION = { id: "fixture-lifecycle", version: "1.0.0", workflows: [NOTE], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
const PERSON = { interactive: true, as: "Ada" };
afterEach(() => vi.unstubAllEnvs());

async function home(): Promise<string> {
  const created = await runnerHome();
  await writePinnedSolution(created, JSON.stringify(SOLUTION));
  return created;
}

const memos = async (at: string) => ((await invokeTool(await toolContext(at, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const check = (at: string, name: string) => runCheck(at, { check: name });

describe("WORKFLOWS: a workflow v1 from a suggestion or from plain words (§6.2, D98)", () => {
  it("lists the recipe's suggestions and adds one as version 1, in sandbox", async () => {
    const at = await home();
    expect(await workflowCommand(at, "suggestions", undefined, undefined, () => AT)).toEqual({ suggestions: [{ workflow: "note", description: "Adds a memo each weekday morning", mode: "typed", trigger: NOTE.trigger }] });
    expect(await check(at, "workflows_present")).toMatchObject({ ok: false, hint: expect.stringContaining("taskfollow workflow suggestions") });
    expect(await workflowCommand(at, "add", "note", undefined, () => AT)).toMatchObject({ status: "added", workflow: "note", version: 1, mode: "typed", sandbox: true });
    expect(await loadWorkflowState(at, "note")).toEqual({ workflow: "note", sandbox: true });
    expect(await check(at, "workflows_present")).toEqual({ ok: true });
    await expect(workflowCommand(at, "add", "note", undefined, () => AT)).rejects.toThrow("exists already");
    await expect(workflowCommand(at, "add", "other", undefined, () => AT)).rejects.toThrow("No suggested workflow 'other' (note)");
  });

  it("turns the person's description into an agentic version 1", async () => {
    const at = await home();
    const words = JSON.stringify({ description: "Each morning, read the memos and add one that counts them.", tools: ["memo.list", "memo.add"] });
    expect(await workflowCommand(at, "add", "count", words, () => AT)).toMatchObject({ status: "added", mode: "agentic" });
    expect(JSON.parse(await readFile(join(at, "workflows/count/workflow.json"), "utf8"))).toEqual({ workflow: "count", version: 1, mode: "agentic", description: "Each morning, read the memos and add one that counts them.", instructions: "Each morning, read the memos and add one that counts them.", tools: ["memo.list", "memo.add"] });
    await expect(workflowCommand(at, "add", "bad", JSON.stringify({ description: "x", tools: ["files.write"] }), () => AT)).rejects.toThrow("names no known tool");
    await expect(workflowCommand(at, "add", "bad", "{}", () => AT)).rejects.toThrow("needs the person's description");
    expect((await workflowCommand(at, "list", undefined, undefined, () => AT)).workflows).toEqual([expect.objectContaining({ workflow: "count", mode: "agentic", sandbox: true })]);
  });
});

describe("WORKFLOWS: a workflow the agent writes as fixed steps (D142)", () => {
  const STEPS = {
    description: "Looks up an order when a customer asks",
    trigger: { event: "message.received", from: "external" },
    steps: [{ id: "lookup", task: { prompt: "Find the order.", input: { message: "${event.text}" }, may_use: ["mcp__shopify__get_order"], output: { type: "object", properties: { order_found: { type: "boolean" } }, required: ["order_found"] } } }],
  };

  it("adds steps the agent wrote as a typed version 1, in sandbox", async () => {
    const at = await home();
    expect(await workflowCommand(at, "add", "order-status", JSON.stringify(STEPS), () => AT)).toMatchObject({ status: "added", workflow: "order-status", version: 1, mode: "typed", sandbox: true });
    expect((await workflowCommand(at, "list", undefined, undefined, () => AT)).workflows).toEqual([expect.objectContaining({ workflow: "order-status", mode: "typed", sandbox: true })]);
  });

  it("refuses steps that do not hold together, with the reason", async () => {
    const at = await home();
    await expect(workflowCommand(at, "add", "bad", JSON.stringify({ ...STEPS, steps: [{ id: "lookup", task: { prompt: "x", may_use: ["*"], output: STEPS.steps[0]?.task.output } }] }), () => AT)).rejects.toThrow("may_use");
    await expect(workflowCommand(at, "add", "bad", JSON.stringify({ steps: STEPS.steps }), () => AT)).rejects.toThrow("needs the person's description");
  });
});

describe("DRY RUN: a sandbox run the person reads and confirms (§6.2, D98)", () => {
  it("shows what the workflow would do, changes nothing, and is confirmed in a terminal only", async () => {
    const at = await home();
    await workflowCommand(at, "add", "note", undefined, () => AT);
    expect(await check(at, "dry_runs_done")).toMatchObject({ ok: false, hint: expect.stringContaining("note") });
    await expect(dryrunCommand(at, "confirm", "note", PERSON, () => AT)).rejects.toThrow("has no dry run of version 1 yet");
    const shown = await dryrunCommand(at, undefined, undefined, PERSON, () => AT);
    expect(shown.dry_runs).toEqual([expect.objectContaining({ workflow: "note", status: "completed", steps: [expect.objectContaining({ step: "add", status: "done" })], would_have: [expect.objectContaining({ action: { tool: "memo.add", args: { text: "Good morning" } }, level: "L1" })] })]);
    expect(await memos(at)).toEqual([]);
    expect(await check(at, "dry_runs_done")).toEqual({ ok: true });
    expect(await check(at, "dry_runs_confirmed")).toMatchObject({ ok: false });
    await expect(dryrunCommand(at, "confirm", "note", { interactive: false }, () => AT)).rejects.toThrow("in their own terminal");
    expect(await dryrunCommand(at, "confirm", "note", PERSON, () => AT)).toMatchObject({ status: "confirmed", workflow: "note", version: 1 });
    expect(await loadWorkflowState(at, "note")).toMatchObject({ sandbox: false, dry_run: { confirmed_by: "Ada" } });
    expect(await check(at, "dry_runs_confirmed")).toEqual({ ok: true });
  });

  it("asks again for a new version", async () => {
    const at = await home();
    await workflowCommand(at, "add", "note", undefined, () => AT);
    await dryrunCommand(at, "note", undefined, PERSON, () => AT);
    await dryrunCommand(at, "confirm", "note", PERSON, () => AT);
    await writeWorkflow(at, { ...NOTE, version: 2 });
    expect(await check(at, "dry_runs_confirmed")).toMatchObject({ ok: false });
  });
});

describe("DRY RUN of a workflow that starts on a message (D88, D98)", () => {
  const GREET = { workflow: "greet", version: 1, trigger: { event: "message.received", from: "external" }, steps: [{ id: "add", tool: "memo.add", args: { text: "Got: ${event.text}" } }] };
  const message = (at: string, text: string, route: Route) => storeInbound(at, normalizeInbound({ channel: "telegram", from: "7007", thread: "7007", text, message_id: text }, AT), route);
  const noted = (shown: Record<string, unknown>) => (shown.dry_runs as { would_have: { action: { args: { text: string } } }[] }[])[0]?.would_have.map((entry) => entry.action.args.text);

  it("binds the latest stored message that matches the trigger as the event, and says so", async () => {
    const at = await home();
    await writeWorkflow(at, GREET);
    await message(at, "first", "event");
    const latest = await message(at, "latest", "event");
    await message(at, "from a member", "conversation");
    const shown = await dryrunCommand(at, "greet", undefined, PERSON, () => AT);
    expect(shown.dry_runs).toEqual([expect.objectContaining({ status: "completed", sample: { inbox_id: latest.id } })]);
    expect(noted(shown)).toEqual(["Got: latest"]);
    expect((await loadWorkflowState(at, "greet"))?.dry_run).toMatchObject({ status: "completed", sample: { inbox_id: latest.id } });
  });

  it("binds a synthetic sample from --value when no message matches, labelled as one", async () => {
    const at = await home();
    await writeWorkflow(at, GREET);
    const shown = await dryrunCommand(at, "greet", undefined, PERSON, () => AT, JSON.stringify({ text: "a sample" }));
    expect(shown.dry_runs).toEqual([expect.objectContaining({ status: "completed", sample: { synthetic: { text: "a sample" } } })]);
    expect(noted(shown)).toEqual(["Got: a sample"]);
    expect((await loadWorkflowState(at, "greet"))?.dry_run).toMatchObject({ sample: { synthetic: { text: "a sample" } } });
  });

  it("refuses when there is neither a stored message nor a sample", async () => {
    const at = await home();
    await writeWorkflow(at, GREET);
    await expect(dryrunCommand(at, "greet", undefined, PERSON, () => AT)).rejects.toThrow(InputError);
    await expect(dryrunCommand(at, "greet", undefined, PERSON, () => AT)).rejects.toThrow("--value '<sample event json>'");
    await expect(dryrunCommand(at, "greet", undefined, PERSON, () => AT, "[1]")).rejects.toThrow("--value '<sample event json>'");
    expect(await loadWorkflowState(at, "greet")).toBeNull();
  });
});

describe("ACTIVATE (§6.2, D98)", () => {
  it("leaves sandbox mode only once every workflow is confirmed", async () => {
    const at = await home();
    await runAction(at, { action: "enter_sandbox" });
    expect(await sandboxMode(at)).toBe(true);
    await workflowCommand(at, "add", "note", undefined, () => AT);
    await expect(runAction(at, { action: "leave_sandbox" })).rejects.toThrow(ActionFailure);
    await dryrunCommand(at, "note", undefined, PERSON, () => AT);
    await dryrunCommand(at, "confirm", "note", PERSON, () => AT);
    await runAction(at, { action: "leave_sandbox" });
    expect(await sandboxMode(at)).toBe(false);
  });

  it("starts the gateway only when a channel is set up, as a failure the person can fix", async () => {
    const at = await home();
    await expect(runAction(at, { action: "start_gateway" })).rejects.toThrow("No channel is set up yet");
  });

  it("checks that the OS scheduler runs the tick", async () => {
    const at = await makeTempHome();
    expect(await check(at, "runner_ticking")).toMatchObject({ ok: false, hint: expect.stringContaining("taskfollow schedule install") });
    await writeConfig(at, HEARTBEAT_FILE, { last: new Date().toISOString(), pid: 1 });
    expect(await check(at, "runner_ticking")).toEqual({ ok: true });
  });
});

describe("a suggested workflow whose judge names a Skills Wiki skill (D126)", () => {
  const SKILLED = { ...MEMO_DIGEST, workflow: "skilled", steps: MEMO_DIGEST.steps.map((step) => ("judge" in step ? { ...step, judge: { ...step.judge, skill: "skillswiki:p/s/SKILL.md" } } : step)) };

  async function skilledHome(skillswikiUrl?: string): Promise<string> {
    const created = await runnerHome();
    await writePinnedSolution(created, JSON.stringify({ ...SOLUTION, workflows: [SKILLED] }));
    const state = await loadState(created);
    if (skillswikiUrl && state) await saveState(created, { ...state, skillswiki: { url: skillswikiUrl } });
    return created;
  }

  it("is refused at add time, in plain words, when the install has no Skills Wiki", async () => {
    const at = await skilledHome();
    await expect(workflowCommand(at, "add", "skilled", undefined, () => AT)).rejects.toThrow(/uses a Skills Wiki skill.*Connect Skills Wiki/);
    expect(await workflowIds(at)).toEqual([]);
  });

  it("is added when the install has Skills Wiki", async () => {
    const at = await skilledHome("https://wiki.test/mcp");
    expect(await workflowCommand(at, "add", "skilled", undefined, () => AT)).toMatchObject({ status: "added", workflow: "skilled" });
  });
});

describe("a suggested workflow that runs in the computer's own time zone (D130)", () => {
  const LOCAL = { ...NOTE, workflow: "local-note", trigger: { cron: "0 9 * * 1", tz: "local" } };

  it("is added with this computer's real time zone, because a laptop that is asleep at 4 a.m. would miss a run set in UTC", async () => {
    const at = await runnerHome();
    await writePinnedSolution(at, JSON.stringify({ ...SOLUTION, workflows: [LOCAL] }));
    await workflowCommand(at, "add", "local-note", undefined, () => AT);
    const { trigger } = await loadWorkflow(at, "local-note", DEFAULT_TOOLS);
    expect(trigger).toMatchObject({ kind: "cron", cron: "0 9 * * 1", tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  it("leaves a workflow with a named zone alone", async () => {
    const at = await runnerHome();
    await writePinnedSolution(at, JSON.stringify({ ...SOLUTION, workflows: [{ ...LOCAL, trigger: { cron: "0 9 * * 1", tz: "America/Toronto" } }] }));
    await workflowCommand(at, "add", "local-note", undefined, () => AT);
    expect((await loadWorkflow(at, "local-note", DEFAULT_TOOLS)).trigger).toMatchObject({ tz: "America/Toronto" });
  });
});

describe("a suggested workflow that depends on a choice (D131)", () => {
  const NEEDS_SHEET = { ...NOTE, workflow: "needs-sheet", when: { step: "records", equals: "google-sheets" } };
  const PICKER = { step_id: "records", phase: "MODE", type: "ask", title: "Where is your list?", why: "Needed.", blocking: true, input: { kind: "choice", options: ["google-sheets", "none"] } };

  async function homeWith(choice: string): Promise<string> {
    const at = await runnerHome();
    await writePinnedSolution(at, JSON.stringify({ ...SOLUTION, steps: [PICKER, ...SOLUTION.steps], workflows: [NOTE, NEEDS_SHEET] }));
    const state = await loadState(at);
    if (state) await saveState(at, { ...state, steps: { records: { status: "done", at: AT, by: "human", value: choice } } });
    return at;
  }

  it("is offered when the choice was made", async () => {
    const at = await homeWith("google-sheets");
    const listed = (await workflowCommand(at, "suggestions", undefined, undefined, () => AT)) as { suggestions: { workflow: string }[] };
    expect(listed.suggestions.map((entry) => entry.workflow)).toEqual(["note", "needs-sheet"]);
    expect(await workflowCommand(at, "add", "needs-sheet", undefined, () => AT)).toMatchObject({ status: "added", workflow: "needs-sheet" });
  });

  it("is not offered, and cannot be added, when the person chose something else", async () => {
    const at = await homeWith("none");
    const listed = (await workflowCommand(at, "suggestions", undefined, undefined, () => AT)) as { suggestions: { workflow: string }[] };
    expect(listed.suggestions.map((entry) => entry.workflow)).toEqual(["note"]);
    await expect(workflowCommand(at, "add", "needs-sheet", undefined, () => AT)).rejects.toThrow("No suggested workflow 'needs-sheet' (note)");
  });
});

describe("WORKFLOWS: skills for a workflow (9.12 item 2, D126 changed)", () => {
  async function userSkill(name: string): Promise<string> {
    const root = process.env.INSTALLER_AGENT_USER_SKILLS ?? "";
    const folder = join(root, name);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill.\n---\nDo it well.\n`);
    return folder;
  }
  const raw = async (at: string, id: string) => JSON.parse(await readFile(join(at, "workflows", id, "workflow.json"), "utf8")) as Record<string, unknown>;

  it("adds a workflow with a local skill without Skills Wiki", async () => {
    const at = await home();
    const folder = await userSkill("count-rules");
    const words = JSON.stringify({ description: "Count the memos.", tools: ["memo.list", "memo.add"], skills: [folder] });
    expect(await workflowCommand(at, "add", "count", words, () => AT)).toMatchObject({ status: "added" });
    expect((await raw(at, "count")).skills).toEqual([folder]);
    expect((await workflowCommand(at, "list", undefined, undefined, () => AT)).workflows).toEqual([expect.objectContaining({ workflow: "count", skills: [folder] })]);
  });

  it("still needs Skills Wiki for a skillswiki reference", async () => {
    const at = await home();
    const words = JSON.stringify({ description: "Count the memos.", tools: ["memo.list"], skills: ["skillswiki:p/s/SKILL.md"] });
    await expect(workflowCommand(at, "add", "count", words, () => AT)).rejects.toThrow("Connect Skills Wiki first");
  });

  it("adds a suggestion with the skills the person confirmed", async () => {
    const at = await home();
    const folder = await userSkill("note-rules");
    expect(await workflowCommand(at, "add", "note", JSON.stringify({ skills: [folder] }), () => AT)).toMatchObject({ status: "added", mode: "typed" });
    expect(await raw(at, "note")).toMatchObject({ steps: NOTE.steps, skills: [folder] });
  });

  it("refuses a folder outside the agent's skill folders and writes nothing", async () => {
    const at = await home();
    const outside = await makeTempHome();
    await writeFile(join(outside, "SKILL.md"), "---\nname: x\n---\n");
    await expect(workflowCommand(at, "add", "count", JSON.stringify({ description: "Count.", tools: ["memo.list"], skills: [outside] }), () => AT)).rejects.toThrow("is not inside your agent's skills folders");
    expect(await workflowIds(at)).toEqual([]);
  });

  it("refuses more than 9 skills from the person: the workflow's own skill takes the tenth place", async () => {
    const at = await home();
    const folders = await Promise.all(Array.from({ length: 10 }, (_, index) => userSkill(`s${index}`)));
    await expect(workflowCommand(at, "add", "count", JSON.stringify({ description: "Count.", tools: ["memo.list"], skills: folders }), () => AT)).rejects.toThrow("at most 9 skills");
  });

  it("writes no skills key when none were given", async () => {
    const at = await home();
    await workflowCommand(at, "add", "count", JSON.stringify({ description: "Count.", tools: ["memo.list"] }), () => AT);
    expect(await raw(at, "count")).not.toHaveProperty("skills");
  });
});
