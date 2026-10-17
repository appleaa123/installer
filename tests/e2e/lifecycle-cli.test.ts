import { describe, expect, it } from "vitest";
import { writePinnedSolution } from "../../src/core/pin.js";
import { runCli } from "../helpers/cli.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** The runner home's solution (fixture-runner@1.0.0), pinned, with one suggested workflow. */
const SOLUTION = {
  id: "fixture-runner", version: "1.0.0",
  workflows: [{ workflow: "note", description: "Adds a memo", steps: [{ id: "add", tool: "memo.add", args: { text: "Hello" } }] }],
  steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }],
};

async function home(): Promise<string> {
  const created = await runnerHome();
  await writePinnedSolution(created, JSON.stringify(SOLUTION));
  return created;
}

describe("taskfollow workflow, dryrun, sandbox, harden, autonomy, alerts and learnings (§6.6, D98)", () => {
  it("adds a suggested workflow, dry-runs it, and leaves confirming to the person's terminal", async () => {
    const dir = await home();
    expect(runCli(["workflow", "suggestions"], { home: dir }).json).toEqual({ suggestions: [{ workflow: "note", description: "Adds a memo", mode: "typed", trigger: { manual: true } }] });
    expect(runCli(["workflow", "add", "note"], { home: dir }).json).toMatchObject({ status: "added", workflow: "note", sandbox: true });
    const dry = runCli(["dryrun", "note"], { home: dir });
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dry_runs: [{ workflow: "note", status: "completed", would_have: [{ action: { tool: "memo.add" }, level: "L1" }] }] });
    expect(runCli(["dryrun", "confirm", "note"], { home: dir }).json).toEqual({ error: expect.stringContaining("in their own terminal"), code: 2 });
    expect(runCli(["workflow", "list"], { home: dir }).json).toMatchObject({ workflows: [{ workflow: "note", sandbox: true, dry_run: { version: 1, status: "completed" } }] });
  });

  it("dry-runs a workflow that starts on a message with a sample, and refuses without one (exit 2)", async () => {
    const dir = await home();
    await writeWorkflow(dir, { workflow: "greet", version: 1, trigger: { event: "message.received", from: "external" }, steps: [{ id: "add", tool: "memo.add", args: { text: "Got: ${event.text}" } }] });
    expect(runCli(["dryrun", "greet"], { home: dir })).toMatchObject({ code: 2, json: { error: expect.stringContaining("--value '<sample event json>'") } });
    const dry = runCli(["dryrun", "greet", "--value", '{"text":"hi"}'], { home: dir });
    expect(dry).toMatchObject({ code: 0, json: { dry_runs: [{ status: "completed", sample: { synthetic: { text: "hi" } }, would_have: [{ action: { args: { text: "Got: hi" } } }] }] } });
  });

  it("lets the agent turn sandbox on, never off", async () => {
    const dir = await home();
    expect(runCli(["sandbox", "on"], { home: dir }).json).toMatchObject({ status: "on", mode: { on: true, by: "agent" } });
    expect(runCli(["sandbox", "off"], { home: dir })).toMatchObject({ code: 2, json: { error: expect.stringContaining("taskfollow sandbox off' in their own terminal") } });
    expect(runCli(["sandbox"], { home: dir }).json).toMatchObject({ mode: { on: true } });
  });

  it("shows hardening, autonomy, alerts and learnings, and refuses their changes from an agent's shell", async () => {
    const dir = await home();
    runCli(["workflow", "add", "note"], { home: dir });
    expect(runCli(["harden", "note"], { home: dir }).json).toEqual({ workflow: "note", version: 1, proposal: null, reason: "workflow 'note' has no agent step at its end (with its default input) to harden" });
    expect(runCli(["harden", "note", "apply"], { home: dir }).code).toBe(2);
    expect(runCli(["autonomy"], { home: dir }).json).toEqual({ streak_needed: 25, types: [], grants: [] });
    expect(runCli(["autonomy", "grant", "note/add/memo.add", "--as", "Owner"], { home: dir }).json).toMatchObject({ code: 2, error: expect.stringContaining("decision maker runs it in their own terminal") });
    expect(runCli(["alerts"], { home: dir }).json).toEqual({ alerts: [] });
    expect(runCli(["alerts", "ack", "1"], { home: dir }).code).toBe(2);
    expect(runCli(["learnings"], { home: dir }).json).toEqual({ learnings: [], rule_candidates: [] });
  });
});
