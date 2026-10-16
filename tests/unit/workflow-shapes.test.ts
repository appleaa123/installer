import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkValues, contractTags } from "../../src/core/contract.js";
import { SHAPES } from "../../src/core/homes.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { deriveLevel } from "../../src/core/levels.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { startRun } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { loadWorkflowState } from "../../src/core/sandbox.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import type { InstallState, StepRecord, StepWhen } from "../../src/core/types.js";
import { whenHolds } from "../../src/core/visibility.js";
import { loadWorkflow, parseWorkflow, type WorkflowStep } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 6a (D166, D171): the four back-office shapes, the invoices-due report and the fallback records they write. */
const RAW = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { workflows: Record<string, unknown>[] };
const STARTER = parseSolution(RAW);
const CONTRACT = STARTER.data_contract ?? { entities: {} };
const AT = "2026-10-16T12:00:00.000Z";
const REPORT_SENTENCE = "If channel.list shows nobody who joined a channel, send nothing and finish with the note as your summary";

/** A suggestion as shipped, without its `when`. */
const entry = (id: string): Record<string, unknown> => {
  const { when: _when, ...found } = RAW.workflows.find((flow) => flow.workflow === id) ?? {};
  return found;
};
/** A suggestion parsed as `workflow add` would load it once the person kept its trigger. */
const shape = (id: string) => parseWorkflow({ ...entry(id), version: 1 }, id, DEFAULT_TOOLS);
const step = (id: string, stepId: string): WorkflowStep | undefined => shape(id).steps.find((entryStep) => entryStep.id === stepId);
const done = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
const answered = (answers: Record<string, unknown>): InstallState => ({
  schema: 1, solution: { ref: "file:starter.json", id: STARTER.id, version: STARTER.version }, started_at: AT,
  steps: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, done(value)])),
});
const offered = (answers: Record<string, unknown>): string[] => (STARTER.workflows ?? []).filter((flow) => whenHolds(flow.when as StepWhen | undefined, answered(answers))).map((flow) => flow.workflow as string);
const SOLO = { "mode.purpose": "install", "mode.who": "me", "services.records": "none", "services.telegram": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

/** A runner home with an install folder and the given suggestions pinned. */
async function shapesHome(ids: readonly string[]): Promise<string> {
  const home = await runnerHome();
  const work = await mkdtemp(join(tmpdir(), "install-folder-"));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  const solution = { id: "fixture-shapes", version: "1.0.0", workflows: ids.map(entry), steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
  await writePinnedSolution(home, JSON.stringify(solution));
  return home;
}
const added = async (home: string, id: string) => {
  await workflowCommand(home, "add", id, JSON.stringify({ my_rules: "My own rules." }), () => AT);
  return loadWorkflow(home, id, DEFAULT_TOOLS);
};

/** The ending every item-6 shape shares with item 5's triage step (plan: Order and dependencies). */
function expectReportEnding(id: string): void {
  const agents = shape(id).steps.filter((entryStep) => entryStep.kind === "agent");
  expect(agents.map((entryStep) => entryStep.id)).toEqual(["report"]);
  const report = agents[0];
  if (report?.kind !== "agent") throw new Error("no report step");
  expect(report.agent.tools).toEqual(["channel.list", "channel.notify"]);
  expect(report.agent.instructions).toContain(`Use the ${id} skill`);
  expect(report.agent.instructions).toContain(REPORT_SENTENCE);
  expect(shape(id).steps.at(-1)?.id).toBe("report");
}

describe("the fallback records (Task 1, D166)", () => {
  it("starter's contract has lead, invoice and action, and contact is unchanged", () => {
    expect(Object.keys(CONTRACT.entities)).toEqual(["contact", "lead", "invoice", "action"]);
    expect(Object.keys(CONTRACT.entities.contact?.fields ?? {})).toEqual(["name", "email", "notes"]);
    expect(CONTRACT.entities.lead?.key).toBe("email");
    expect(CONTRACT.entities.invoice?.fields.file?.type).toBe("file_ref");
  });

  it("invoice.amount is tagged financial, so records.create of an invoice is L3", () => {
    const derived = deriveLevel({ tool: "records.create", level: "L2", categories: [], writes: [{ entity: "invoice", field: "amount" }] }, contractTags(CONTRACT), {});
    expect(derived.level).toBe("L3");
  });

  it("a lead's status outside its options is refused", () => {
    const lead = CONTRACT.entities.lead;
    if (!lead) throw new Error("no lead entity");
    expect(() => checkValues("lead", lead, { status: "maybe" }, "update")).toThrow("must be one of");
    expect(checkValues("lead", lead, { status: "qualified" }, "update")).toEqual({ status: "qualified" });
  });
});

describe("lead qualification (Task 2)", () => {
  it("lead-qualification loads and records its shape", async () => {
    const home = await shapesHome(["lead-qualification"]);
    expect((await added(home, "lead-qualification")).mode).toBe("typed");
    expect((await loadWorkflowState(home, "lead-qualification"))?.shape).toBe("lead-qualification");
  });

  it("it is offered only when email and Google Sheets were chosen", () => {
    expect(offered({ ...SOLO, "services.email": "email", "services.records": "google-sheets" })).toContain("lead-qualification");
    expect(offered({ ...SOLO, "services.email": "email" })).not.toContain("lead-qualification");
    expect(offered({ ...SOLO, "services.records": "google-sheets" })).not.toContain("lead-qualification");
    expect(offered({ "mode.purpose": "consult" })).not.toContain("lead-qualification");
  });

  it("starts on an email from outside and looks the sender up in lead and in contact", () => {
    expect(shape("lead-qualification").trigger).toMatchObject({ kind: "event", from: "external", channel: "email" });
    for (const [id, entity] of [["known_lead", "lead"], ["known_contact", "contact"]] as const) {
      expect(step("lead-qualification", id)).toMatchObject({ kind: "tool", tool: "records.find", args: { entity, where: { email: "${event.from}" } } });
    }
  });

  it("SHAPES lead-qualification needs reads:email, not reads:messages", () => {
    expect(SHAPES["lead-qualification"]?.needs).toContain("reads:email");
    expect(SHAPES["lead-qualification"]?.needs).not.toContain("reads:messages");
  });

  it("the qualify schema has name, and save writes name and email", () => {
    const qualify = step("lead-qualification", "qualify");
    if (qualify?.kind !== "judge") throw new Error("qualify is not a judge");
    expect(Object.keys((qualify.judge.schema as { properties: object }).properties)).toEqual(expect.arrayContaining(["new", "name", "fit", "next_step", "reply", "why"]));
    expect(step("lead-qualification", "save")).toMatchObject({ kind: "approve", tool: "records.create", when: "qualify.new == true", args: { entity: "lead", values: { name: "${qualify.name}", email: "${event.from}", source: "email" } } });
  });

  it("save and reply are approve steps, conditioned on qualify.new and a non-empty reply", () => {
    expect(step("lead-qualification", "reply")).toMatchObject({ kind: "approve", tool: "channel.send", when: 'qualify.reply != ""', args: { channel: "email", to: "${event.from}", reply_to: "${event.message_id}" } });
  });

  it("report is the only agent step and says finish with the note as your summary", () => {
    expectReportEnding("lead-qualification");
  });
});

describe("CRM update (Task 3)", () => {
  it("crm-update loads and records its shape", async () => {
    const home = await shapesHome(["crm-update"]);
    expect((await added(home, "crm-update")).mode).toBe("typed");
    expect((await loadWorkflowState(home, "crm-update"))?.shape).toBe("crm-update");
  });

  it("is offered with Google Sheets and a channel (a team always has one), never without Sheets", () => {
    const sheets = { ...SOLO, "services.records": "google-sheets" };
    expect(offered({ ...sheets, "services.telegram": "telegram" })).toContain("crm-update");
    expect(offered({ ...sheets, "mode.who": "team" })).toContain("crm-update");
    expect(offered(sheets)).not.toContain("crm-update");
    expect(offered({ ...SOLO, "services.telegram": "telegram" })).not.toContain("crm-update");
  });

  it("starts on a member's message, and change is an approve step for records.update", () => {
    expect(shape("crm-update").trigger).toMatchObject({ kind: "event", from: "member" });
    expect(step("crm-update", "current")).toMatchObject({ kind: "tool", tool: "records.get", when: "which.found == true" });
    expect(step("crm-update", "change")).toMatchObject({ kind: "approve", tool: "records.update", when: "which.found == true", args: { entity: "${which.entity}", key: "${which.key}", values: "${which.changes}" } });
  });

  it("with found false no records step runs and the result holds the question", async () => {
    const home = await shapesHome(["crm-update"]);
    const workflow = await added(home, "crm-update");
    const question = "Which record do you mean: there is no contact named Sam.";
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ entity: "", key: "", changes: {}, found: false, question }, { tool: "done", summary: question }]));
    const run = await startRun({ home, workflow, key: `crm-update:${AT}`, trigger: { kind: "manual", sample_event: { channel: "telegram", from: "owner", text: "note that Sam moved", untrusted: true, synthetic: true } }, now: () => AT, sandbox: true });
    expect(run.status).toBe("completed");
    expect((await loadStep(home, run, "current"))?.skipped).toBe(true);
    expect((await loadStep(home, run, "change"))?.skipped).toBe(true);
    expect((await loadStep(home, run, "report"))?.output).toMatchObject({ summary: question });
  });

  it("report is the only agent step and says finish with the note as your summary", () => {
    expectReportEnding("crm-update");
  });
});

describe("invoice processing (Task 5)", () => {
  const REF = "data/inbox-files/0123456789abcdef/invoice.txt";

  it("invoice-processing loads and records its shape, offered only with email and Google Sheets", async () => {
    const home = await shapesHome(["invoice-processing"]);
    expect((await added(home, "invoice-processing")).mode).toBe("typed");
    expect((await loadWorkflowState(home, "invoice-processing"))?.shape).toBe("invoice-processing");
    expect(offered({ ...SOLO, "services.email": "email", "services.records": "google-sheets" })).toContain("invoice-processing");
    expect(offered({ ...SOLO, "services.email": "email" })).not.toContain("invoice-processing");
  });

  it("read may use only Read, from attachments, and its input carries the attachment references", () => {
    expect(shape("invoice-processing").trigger).toMatchObject({ kind: "event", from: "external", channel: "email" });
    expect(step("invoice-processing", "read")).toMatchObject({ kind: "task", task: { may_use: ["Read"], read_from: "attachments", changes: false, input: { attachments: "${event.attachments}" } } });
  });

  it("an invoice record is L3 and waits for the decision maker", () => {
    const save = step("invoice-processing", "save");
    expect(save).toMatchObject({ kind: "approve", tool: "records.create", when: "read.is_invoice == true", args: { entity: "invoice", values: { amount: "${read.amount}", status: "to check" } } });
    const writes = Object.keys((save as unknown as { args: { values: object } }).args.values).map((field) => ({ entity: "invoice", field }));
    expect(deriveLevel({ tool: "records.create", level: "L2", categories: [], writes }, contractTags(CONTRACT), {}).level).toBe("L3");
  });

  it("with is_invoice false the save step does not run, and the agent read exactly the saved attachment", async () => {
    const home = await shapesHome(["invoice-processing"]);
    const workflow = await added(home, "invoice-processing");
    await mkdir(join(home, "data", "inbox-files", "0123456789abcdef"), { recursive: true });
    await writeFile(join(home, REF), "Not an invoice, just a menu.");
    const file = await realpath(join(home, REF));
    const answer = { is_invoice: false, vendor: "", number: "", amount: "", currency: "", due: "", file: "" };
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [{ tool: "Read", input: { file_path: file } }, { tool: "Read", input: { file_path: join(home, "state", "install-state.json") } }], answer }));
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "The email from cafe@example.com held no invoice." }]));
    const event = { channel: "email", from: "cafe@example.com", text: "Our menu", attachments: [REF], message_id: "<m1@example.com>", untrusted: true, synthetic: true };
    const run = await startRun({ home, workflow, key: `invoice-processing:${AT}`, trigger: { kind: "manual", sample_event: event }, now: () => AT, sandbox: true });
    expect(run.status).toBe("completed");
    expect((await loadStep(home, run, "save"))?.skipped).toBe(true);
    const calls = (await readFile(join(home, "runs", "invoice-processing", run.run_id, "read.calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { tool: string; outcome: string });
    expect(calls.filter((call) => call.tool === "Read").map((call) => call.outcome)).toEqual(["ok", "refused"]);
  });

  it("report is the only agent step and says finish with the note as your summary", () => {
    expectReportEnding("invoice-processing");
  });
});
