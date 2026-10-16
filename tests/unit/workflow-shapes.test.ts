import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkValues, contractTags } from "../../src/core/contract.js";
import { SHAPES } from "../../src/core/homes.js";
import { workflowCommand } from "../../src/core/lifecycle.js";
import { deriveLevel } from "../../src/core/levels.js";
import { writePinnedSolution } from "../../src/core/pin.js";
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
