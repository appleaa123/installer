import { readFile } from "node:fs/promises";
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
import { writeWorkflow } from "../helpers/workflow-home.js";

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
    expect(await check(at, "workflows_present")).toMatchObject({ ok: false, hint: expect.stringContaining("installer workflow suggestions") });
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
    expect(await check(at, "runner_ticking")).toMatchObject({ ok: false, hint: expect.stringContaining("installer schedule install") });
    await writeConfig(at, HEARTBEAT_FILE, { last: new Date().toISOString(), pid: 1 });
    expect(await check(at, "runner_ticking")).toEqual({ ok: true });
  });
});
