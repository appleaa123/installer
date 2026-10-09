import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveItem, editItem, getApproval, listApprovals, rejectItem, requestApproval, type PreparedAction } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { AUTONOMY_STREAK, autonomyCommand, ownL2, streakOf } from "../../src/core/autonomy.js";
import { FLOOR_CATEGORIES, NO_TAGS, deriveLevel, type LevelFacts } from "../../src/core/levels.js";
import { resumeRun, startRun } from "../../src/core/runner.js";
import type { RunRecord } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, prepareAction, requireTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { OWNER_ROLES, runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const ADA = { name: "Ada", role: "member" as const };
const OWNER = { interactive: true, as: "Owner" };
const TYPE = "fix/edit/memo.edit";
const FIX = parseWorkflow({ workflow: "fix", version: 1, steps: [{ id: "edit", tool: "memo.edit", args: { id: 1, text: "${run.id}" } }] }, "fix", DEFAULT_TOOLS);
let counter = 0;

const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const begin = (home: string, workflow = FIX) => startRun({ home, workflow, key: `${workflow.id}:manual:${(counter += 1)}`, trigger: { kind: "manual" }, now: () => AT });
const resume = (home: string, run: RunRecord, workflow = FIX) => resumeRun({ home, workflow, key: run.key, trigger: run.trigger, now: () => AT }, run);

async function home(): Promise<string> {
  const created = await runnerHome();
  await invokeTool(await toolContext(created, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "start" });
  return created;
}

/** `count` runs whose step asks for approval, each approved by a person, then finished. */
async function approvedRuns(at: string, count: number, workflow = FIX, decider = ADA): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const run = await begin(at, workflow);
    await approveItem(at, run.waiting_on ?? 0, decider, AT);
    expect(await resume(at, run, workflow)).toMatchObject({ status: "completed" });
  }
}

describe("streaks (§11.6, D94)", () => {
  it("count a person's approvals of one typed step in a row; an edit or a rejection starts again", async () => {
    const at = await home();
    await approvedRuns(at, 2);
    const edited = await begin(at);
    const ctx = await toolContext(at, "cli", DEFAULT_TOOLS, () => AT);
    await editItem(at, edited.waiting_on ?? 0, await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "changed" }), ADA, AT);
    await resume(at, edited);
    await approvedRuns(at, 1);
    expect(streakOf(await listApprovals(at, AT), TYPE)).toBe(1);
    const rejected = await begin(at);
    await rejectItem(at, rejected.waiting_on ?? 0, ADA, "no", AT);
    expect(streakOf(await listApprovals(at, AT), TYPE)).toBe(0);
  });

  it("never count an approve step or an agent's call", async () => {
    const at = await home();
    const asked = parseWorkflow({ workflow: "fix", version: 1, steps: [{ id: "edit", approve: { tool: "memo.edit", args: { id: 1, text: "x" }, why: "asked" } }] }, "fix", DEFAULT_TOOLS);
    await approvedRuns(at, 2, asked);
    expect((await getApproval(at, 1, AT)).source.run?.policy).toBeUndefined();
    expect(streakOf(await listApprovals(at, AT), TYPE)).toBe(0);
  });
});

describe("granting earned autonomy (§11.6, D94)", () => {
  it("is proposed once at the streak, granted by the decision maker in a terminal, and then approves that step itself", async () => {
    const at = await home();
    await approvedRuns(at, AUTONOMY_STREAK - 1);
    await expect(autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: TYPE, ...OWNER }, () => AT)).rejects.toThrow(`has ${AUTONOMY_STREAK - 1} approvals in a row by a person; a grant needs ${AUTONOMY_STREAK}`);
    await approvedRuns(at, 2);
    expect((await events(at)).filter((event) => event === "autonomy.proposed")).toHaveLength(1);
    await expect(autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: TYPE, interactive: false, as: "Owner" }, () => AT)).rejects.toThrow("in their own terminal");
    await expect(autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: TYPE, interactive: true, as: "Ada" }, () => AT)).rejects.toThrow("Only the decision maker");
    expect(await autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: TYPE, ...OWNER }, () => AT)).toMatchObject({ status: "granted", grant: { id: 1, type: TYPE, granted_by: "Owner", streak: AUTONOMY_STREAK + 1 } });
    const run = await begin(at);
    expect(run).toMatchObject({ status: "completed", actions: 1 });
    const item = (await listApprovals(at, AT)).at(-1);
    expect(item).toMatchObject({ status: "used", level: "L2", decision: { decision: "approved", by: "earned autonomy (grant 1)", role: "member" } });
    expect(await events(at)).toContain("autonomy.granted");
  });

  it("is revoked by a person's later rejection of that step, and the runner waits for people again", async () => {
    const at = await home();
    await approvedRuns(at, AUTONOMY_STREAK);
    const pending = await begin(at);
    await autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: TYPE, ...OWNER }, () => AT);
    await rejectItem(at, pending.waiting_on ?? 0, ADA, "wrong text", "2026-10-08T12:00:01.000Z");
    expect(await begin(at)).toMatchObject({ status: "waiting" });
    expect((await autonomyCommand(at, OWNER_ROLES, { sub: "list", interactive: false }, () => AT)).grants).toEqual([expect.objectContaining({ status: "revoked", revoked_reason: expect.stringContaining("a person rejected approval") })]);
  });

  it("is never granted for an L3 step, even after the streak", async () => {
    const at = await home();
    const drop = await prepareAction(await toolContext(at, "cli", DEFAULT_TOOLS, () => AT), requireTool(DEFAULT_TOOLS, "memo.delete"), { id: 1 });
    for (let index = 0; index < AUTONOMY_STREAK; index += 1) {
      const item = await requestApproval(at, { prepared: drop, why: "tidy", via: "runner", run: { workflow: "drop", run_id: `r${index}`, step: "drop", policy: true } }, AT);
      await approveItem(at, item.id, { name: "Owner", role: "decision_maker" }, AT);
    }
    expect(streakOf(await listApprovals(at, AT), "drop/drop/memo.delete")).toBe(AUTONOMY_STREAK);
    await expect(autonomyCommand(at, OWNER_ROLES, { sub: "grant", arg: "drop/drop/memo.delete", ...OWNER }, () => AT)).rejects.toThrow("never applies to L3");
  });
});

describe("what a grant can never cover (§11.3, §15.1)", () => {
  const prepared = (facts: LevelFacts, rules = {}): PreparedAction => ({ tool: facts.tool, args: {}, expected_values: {}, action_hash: "sha256:x", ...deriveLevel(facts, NO_TAGS, rules) });

  it.each(FLOOR_CATEGORIES)("a %s action", (category) => {
    expect(ownL2(prepared({ tool: "memo.edit", categories: [category], writes: [] }))).toBe(false);
  });

  it("a financial field write, a client rule, or a declared L2", () => {
    const financial: LevelFacts = { tool: "records.update", categories: [], writes: [{ entity: "x", field: "y" }] };
    expect(ownL2({ tool: "records.update", args: {}, expected_values: {}, action_hash: "sha256:x", ...deriveLevel(financial, () => ["financial"], {}) })).toBe(false);
    expect(ownL2(prepared({ tool: "memo.edit", categories: [], writes: [] }, { "memo.edit": "L2" }))).toBe(false);
    expect(ownL2(prepared({ tool: "memo.edit", categories: [], writes: [] }))).toBe(true);
    expect(ownL2(prepared({ tool: "channel.send", level: "L2", categories: [], writes: [] }))).toBe(true);
  });
});
