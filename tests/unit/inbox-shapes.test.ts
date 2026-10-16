import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listApprovals } from "../../src/core/approvals.js";
import { saveChannel } from "../../src/core/channels.js";
import { recordResult, type CheckResult } from "../../src/core/checks.js";
import { checkCommand } from "../../src/core/check-commands.js";
import { deliverToCowork } from "../../src/core/deliver.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { decideHome } from "../../src/core/homes.js";
import { storeInbound } from "../../src/core/inbox.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { resumeRun, startRun } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { loadWorkflow, parseWorkflow } from "../../src/core/workflow.js";
import { readZip } from "../../src/core/zip.js";
import { loadWorkflowState, saveWorkflowState } from "../../src/core/sandbox.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 5: the starter's two inbox suggestions, as shipped, in TaskFollow's runner and toward the agent's scheduler. */
const AT = "2026-10-16T12:00:00.000Z";
const STARTER = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { workflows: Record<string, unknown>[] };
const entry = (id: string): Record<string, unknown> => {
  const { when: _when, ...found } = STARTER.workflows.find((flow) => flow.workflow === id) ?? {};
  return found;
};
const SOLUTION = { id: "fixture-inbox", version: "1.0.0", workflows: [entry("inbox-triage"), entry("inbox-triage-replies")], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
const RUNNER = { agent: "fake-agent", version: "9.9.9" };
const COWORK = { agent: "Claude Cowork", version: null };
const ASKED = "<q1@tenant.example>";
const told = (workflow: string): CheckResult => ({ need: "scheduler", workflow, result: "yes-you-told-us", reason: "you told us", at: AT, agent: "Claude Cowork", agent_version: null, test: "t8", while_away: true });

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());
const answers = (...values: unknown[]) => vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(values));

/** A runner home with the install folder, the two suggestions pinned, an email channel and one tenant's email waiting. */
async function inboxHome(): Promise<{ home: string; work: string }> {
  const home = await runnerHome();
  const work = await mkdtemp(join(tmpdir(), "install-folder-"));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  await writePinnedSolution(home, JSON.stringify(SOLUTION));
  await saveChannel(home, {
    channel: "email", address: "desk@example.com", verified_at: AT,
    imap: { host: "imap.example.com", port: 993, security: "ssl", user: "desk@example.com" }, smtp: { host: "smtp.example.com", port: 465, security: "ssl", user: "desk@example.com" },
  });
  await storeInbound(home, normalizeInbound({ channel: "email", from: "maria@tenant.example", thread: ASKED, text: "The heating is broken at 12 Oak St.", message_id: ASKED, subject: "Heating" }, AT), "event");
  return { home, work };
}
const added = async (home: string, id: string) => {
  await workflowCommand(home, "add", id, JSON.stringify({ my_rules: "Repairs come first.", trigger: { manual: true } }), () => AT);
  return loadWorkflow(home, id, DEFAULT_TOOLS);
};
/** As after `dryrun confirm`: the workflow leaves sandbox, so a live run asks before anything goes out. */
const confirmed = async (home: string, id: string) => {
  const state = await loadWorkflowState(home, id);
  if (state) await saveWorkflowState(home, { ...state, sandbox: false });
};
const runOf = async (home: string, id: string, sandbox: boolean) => startRun({ home, workflow: await loadWorkflow(home, id, DEFAULT_TOOLS), key: `${id}:${AT}`, trigger: { kind: "manual" }, now: () => AT, sandbox });
const LIST = { tool: "done", summary: "1 message needs you: Maria, 12 Oak St: the heating is broken, needs a visit." };
const REPLY = { tool: "channel.send", args: { channel: "email", to: "maria@tenant.example", text: "We will send someone today.", reply_to: ASKED } };

describe("where the inbox shapes run (item 5)", () => {
  it("both suggestions load as typed workflows once the time is the person's", async () => {
    for (const id of ["inbox-triage", "inbox-triage-replies"]) expect(parseWorkflow({ ...entry(id), version: 1, trigger: { manual: true } }, id, DEFAULT_TOOLS).mode).toBe("typed");
  });

  it("inbox-triage is not hard rule and may go to the agent's scheduler after T8", async () => {
    const { home } = await inboxHome();
    const workflow = await added(home, "inbox-triage");
    await recordResult(home, told("inbox-triage"));
    expect((await decideHome(home, workflow, { whileAway: true, runner: RUNNER, homeAgent: COWORK }, AT)).home).toEqual({ home: "agent-scheduler", agent: "Claude Cowork" });
  });

  it("inbox-triage-replies is always the runner or draft-only", async () => {
    const { home } = await inboxHome();
    const workflow = await added(home, "inbox-triage-replies");
    await recordResult(home, told("inbox-triage-replies"));
    const decided = await decideHome(home, workflow, { whileAway: true, runner: RUNNER, homeAgent: COWORK }, AT);
    expect(["runner", "draft-only"]).toContain(decided.home.home);
  });

  it("check deliver refuses inbox-triage-replies", async () => {
    const { home } = await inboxHome();
    const workflow = await added(home, "inbox-triage-replies");
    await recordResult(home, told("inbox-triage-replies"));
    await expect(deliverToCowork(home, workflow, { now: AT, agent: COWORK, runner: RUNNER })).rejects.toThrow("Not delivered");
  });

  it("check deliver inbox-triage writes a zip whose SKILL.md is the shipped one with the owner's rules", async () => {
    const { home } = await inboxHome();
    const workflow = await added(home, "inbox-triage");
    await recordResult(home, told("inbox-triage"));
    const out = await deliverToCowork(home, workflow, { now: AT, agent: COWORK, runner: RUNNER });
    const skill = readZip(await readFile(out.zip))[1]?.data.toString("utf8") ?? "";
    expect(skill).toContain("# Inbox triage");
    expect(skill).toContain("## The owner's own rules\n\nRepairs come first.");
    expect(skill).not.toContain("references/");
  });

  it("a consultation's inbox-triage summary says reads:email is not checked", async () => {
    const { home } = await inboxHome();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, steps: { ...state.steps, "mode.purpose": { status: "done", at: AT, by: "human", value: "consult" } } });
    await added(home, "inbox-triage");
    const out = (await checkCommand(home, (await loadState(home)) ?? undefined, ["summary", "inbox-triage"], {}, { interactive: false, now: () => AT, launch: async () => ({ pid: 0, opened: true }) })) as { lines: string[] };
    expect(out.lines.find((line) => line.includes("Reads your email"))).toContain("not checked");
  });
});

describe("running the inbox shapes (item 5)", () => {
  it("inbox-triage reads the new mail and makes the list", async () => {
    const { home } = await inboxHome();
    await added(home, "inbox-triage");
    answers(LIST);
    const run = await runOf(home, "inbox-triage", false);
    expect(run.status).toBe("completed");
    expect((await loadStep(home, run, "mail"))?.output).toMatchObject({ messages: [{ subject: "Heating" }], newest_id: 1 });
    expect((await loadStep(home, run, "triage"))?.output).toMatchObject({ summary: LIST.summary });
  });

  it("a dry run of inbox-triage-replies records the replies and sends nothing", async () => {
    const { home } = await inboxHome();
    await added(home, "inbox-triage-replies");
    answers(LIST, REPLY, { tool: "done", summary: "Asked to send 1 reply." });
    const run = await runOf(home, "inbox-triage-replies", true);
    expect(run.status).toBe("completed");
    expect(await listApprovals(home, AT)).toEqual([]);
    const recorded = await readdir(join(home, OUTBOX_DIR));
    expect(recorded.length).toBe(1);
    expect(JSON.parse(await readFile(join(home, OUTBOX_DIR, recorded[0] ?? ""), "utf8"))).toMatchObject({ to: "maria@tenant.example", in_reply_to: ASKED });
  });

  it("inbox-triage-replies saves the list before its first reply waits, and asks one approval per reply", async () => {
    const { home } = await inboxHome();
    await added(home, "inbox-triage-replies");
    await confirmed(home, "inbox-triage-replies");
    answers(LIST, REPLY);
    const run = await runOf(home, "inbox-triage-replies", false);
    expect(run).toMatchObject({ status: "waiting" });
    expect((await loadStep(home, run, "triage"))?.output).toMatchObject({ summary: LIST.summary });
    const pending = await listApprovals(home, AT);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ level: "L2", action: { tool: "channel.send", args: { reply_to: ASKED, to: "maria@tenant.example" } } });
  });

  it("says plainly when a reply was not approved in time, and how to get it again (PR #59 review)", async () => {
    const { home } = await inboxHome();
    await added(home, "inbox-triage-replies");
    await confirmed(home, "inbox-triage-replies");
    answers(LIST, REPLY);
    const waiting = await runOf(home, "inbox-triage-replies", false);
    const later = "2026-10-18T12:00:00.000Z";
    const ended = await resumeRun({ home, workflow: await loadWorkflow(home, "inbox-triage-replies", DEFAULT_TOOLS), key: waiting.key, trigger: waiting.trigger, now: () => later }, waiting);
    expect(ended.status).toBe("failed");
    expect(ended.reason).toContain("was not approved within 24 hours, so nothing was sent; ask your agent in chat to draft it again");
  });

  it("checks reply_to before asking: a reply to another address is never put to the person", async () => {
    const { home } = await inboxHome();
    await added(home, "inbox-triage-replies");
    await confirmed(home, "inbox-triage-replies");
    answers(LIST, { ...REPLY, args: { ...REPLY.args, to: "someone-else@example.com" } }, { tool: "done", summary: "No replies." });
    const run = await runOf(home, "inbox-triage-replies", false);
    expect(run.status).not.toBe("waiting");
    expect(await listApprovals(home, AT)).toEqual([]);
  });
});
