import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editItem, rejectItem } from "../../src/core/approvals.js";
import { setSecret } from "../../src/core/keychain.js";
import { prepareAgentCall } from "../../src/core/agent-call.js";
import { getApproval, refuseDecision, requestApproval } from "../../src/core/approvals.js";
import { collectLearnings, collectRuleCandidates, listLearnings, listRuleCandidates, redactValue, submitLearnings } from "../../src/core/learning.js";
import { saveWritten } from "../../src/core/workflow-skill.js";
import { callTool } from "../../src/core/mcp.js";
import { startRun } from "../../src/core/runner.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, prepareAction, requireTool, toolContext } from "../../src/core/tools.js";
import { loadWorkflow } from "../../src/core/workflow.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const ADA = { name: "Ada", role: "member" as const };
const TEXT_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
const SKILL = "skillswiki:demo/install/notes.md";
const fakes: FakeMcp[] = [];
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => {
  vi.unstubAllEnvs();
  fakes.splice(0).forEach((fake) => fake.stop());
});

/** A home connected to a fake Skills Wiki whose workflow drafts a memo with a skill's judge, then edits memo 1 (L2). */
async function home(env: Record<string, string> = {}, skill: string | null = SKILL) {
  const fake = await startFakeMcp(env);
  fakes.push(fake);
  await setSecret("skillswiki", fake.key);
  const at = await runnerHome();
  const state = await loadState(at);
  if (state) await saveState(at, { ...state, skillswiki: { url: fake.url } });
  await invokeTool(await toolContext(at, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "start" });
  await writeWorkflow(at, {
    workflow: "draft", version: 1,
    steps: [{ id: "write", judge: { instructions: "Draft a note.", schema: TEXT_SCHEMA, ...(skill ? { skill } : {}) } }, { id: "save", tool: "memo.edit", args: { id: 1, text: "${write.text}" } }],
  });
  vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ text: "Call ada@example.com on +1 555 123 4567 now" }]));
  const run = await startRun({ home: at, workflow: await loadWorkflow(at, "draft", DEFAULT_TOOLS), key: "draft:1", trigger: { kind: "manual" }, now: () => AT });
  return { at, fake, item: run.waiting_on ?? 0 };
}

describe("candidate learnings (§10.10, D97)", () => {
  it("come from a person's edit of an item a skill's judgment led to, with personal data redacted", async () => {
    const { at, item } = await home();
    const ctx = await toolContext(at, "cli", DEFAULT_TOOLS, () => AT);
    await editItem(at, item, await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "Write to bob@example.com first, gently" }), ADA, AT);
    const [learning] = await collectLearnings(at, AT);
    expect(learning).toMatchObject({ approval: item, workflow: "draft", pack: "demo", skill_slug: "install", status: "pending" });
    expect(learning?.body).toBe("In workflow 'draft', a person changed the memo.edit call that followed this skill's judgment. They changed text to: {\"text\":\"Write to [email] first, gently\"}. Next time, judge similar input the way this correction shows.");
    expect(learning?.body).not.toContain("555");
    expect(await collectLearnings(at, AT)).toEqual([]);
  });

  it("keep a rejection's reason, never the model's own text", async () => {
    const { at, item } = await home();
    await rejectItem(at, item, ADA, "Too pushy; ring 555-123-4567 instead", AT);
    const [learning] = await collectLearnings(at, AT);
    expect(learning?.body).toContain('Their reason: "Too pushy; ring [number] instead"');
    expect(learning?.body).not.toContain("Call");
  });

  it("are not made when no judge with a skill came before the step", async () => {
    const { at, item } = await home({}, null);
    await rejectItem(at, item, ADA, "no", AT);
    expect(await collectLearnings(at, AT)).toEqual([]);
  });

  it("replace the values of fields tagged personal, at any depth", () => {
    expect(redactValue({ name: "Ada", notes: "ok", nested: [{ email: "x" }] }, new Set(["name", "email"]))).toEqual({ name: "[redacted]", notes: "ok", nested: [{ email: "[redacted]" }] });
  });

  it("stay within 600 characters", async () => {
    const { at, item } = await home();
    await rejectItem(at, item, ADA, "x".repeat(900), AT);
    const [learning] = await collectLearnings(at, AT);
    expect(learning?.body).toHaveLength(600);
  });
});

describe("sending learnings to Skills Wiki (fake server only)", () => {
  it("records each once with learning_record, after learning_list", async () => {
    const { at, fake, item } = await home();
    await rejectItem(at, item, ADA, "wrong tone", AT);
    await collectLearnings(at, AT);
    const url = (await loadState(at))?.skillswiki?.url;
    expect(await submitLearnings(at, url, AT)).toEqual([expect.objectContaining({ status: "recorded", sent_at: AT })]);
    expect(await submitLearnings(at, url, AT)).toEqual([]);
    const listed = await callTool({ url: fake.url, key: fake.key }, "learning_list", { pack: "demo" });
    expect(listed).toMatchObject({ ok: true, value: { learnings: [{ pack: "demo", skill_slug: "install", body: expect.stringContaining("wrong tone") }] } });
  });

  it("keeps a refusal (Learning Mode off) with its reason and does not retry it", async () => {
    const { at, item } = await home({ FAKE_MCP_LEARNING: "off" });
    await rejectItem(at, item, ADA, "wrong tone", AT);
    await collectLearnings(at, AT);
    expect(await submitLearnings(at, (await loadState(at))?.skillswiki?.url, AT)).toEqual([expect.objectContaining({ status: "refused", error: expect.stringContaining("Learning Mode is off") })]);
    expect(await submitLearnings(at, (await loadState(at))?.skillswiki?.url, AT)).toEqual([]);
  });

  it("leaves a learning pending, without throwing, on an install that has no Skills Wiki URL (D126)", async () => {
    const { at, item } = await home();
    await rejectItem(at, item, ADA, "wrong tone", AT);
    await collectLearnings(at, AT);
    expect(await submitLearnings(at, undefined, AT)).toEqual([]);
    expect(await listLearnings(at)).toEqual([expect.objectContaining({ status: "pending", error: expect.stringContaining("no Skills Wiki URL") })]);
  });

  it("leaves a learning pending when Skills Wiki cannot be reached, and sends it later", async () => {
    const { at, item } = await home();
    await rejectItem(at, item, ADA, "wrong tone", AT);
    await collectLearnings(at, AT);
    expect(await submitLearnings(at, "http://127.0.0.1:9/mcp", AT)).toEqual([]);
    expect(await listLearnings(at)).toEqual([expect.objectContaining({ status: "pending", error: expect.stringContaining("Cannot reach Skills Wiki") })]);
    expect(await submitLearnings(at, (await loadState(at))?.skillswiki?.url, AT)).toEqual([expect.objectContaining({ status: "recorded" })]);
  });
});

describe("rule candidates for my-rules.md (item 8)", () => {
  /** A home whose workflow has the skill folder TaskFollow wrote, recorded in state/written.json. */
  async function owned(skill: string | null = null) {
    const made = await home({}, skill);
    await saveWritten(made.at, { skill_folders: [{ workflow: "draft", path: `${made.at}/skills/draft`, root: `${made.at}/skills` }] });
    return made;
  }

  it("an edited approval of a workflow with its own skill becomes one open rule candidate", async () => {
    const { at, item } = await owned();
    const ctx = await toolContext(at, "cli", DEFAULT_TOOLS, () => AT);
    await editItem(at, item, await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "Shorter, please" }), ADA, AT);
    const found = await collectRuleCandidates(at, AT);
    expect(found).toEqual([expect.objectContaining({ approval: item, workflow: "draft", step: "save", status: "open", created_at: AT })]);
    expect(found[0]?.body).toBe("In workflow 'draft', a person changed the memo.edit call in step 'save'. They changed text to: {\"text\":\"Shorter, please\"}.");
  });

  it("a rejected approval with a reason keeps the reason, redacted", async () => {
    const { at, item } = await owned();
    await rejectItem(at, item, ADA, "Too formal; ring 555-123-4567", AT);
    const [found] = await collectRuleCandidates(at, AT);
    expect(found?.body).toBe("In workflow 'draft', a person rejected the memo.edit call in step 'save'. Their reason: \"Too formal; ring [number]\".");
  });

  it("the same approval never becomes two candidates, even across ticks", async () => {
    const { at, item } = await owned();
    await rejectItem(at, item, ADA, "no", AT);
    expect(await collectRuleCandidates(at, AT)).toHaveLength(1);
    expect(await collectRuleCandidates(at, AT)).toEqual([]);
    expect(await listRuleCandidates(at)).toHaveLength(1);
  });

  it("a workflow without a skill folder TaskFollow wrote gets no candidate", async () => {
    const { at, item } = await home({}, null);
    await rejectItem(at, item, ADA, "no", AT);
    expect(await collectRuleCandidates(at, AT)).toEqual([]);
  });

  it("a skillswiki judge's correction still becomes a Skills Wiki learning, and a rule candidate too", async () => {
    const { at, item } = await owned(SKILL);
    await rejectItem(at, item, ADA, "wrong tone", AT);
    expect(await collectLearnings(at, AT)).toHaveLength(1);
    expect(await collectRuleCandidates(at, AT)).toHaveLength(1);
  });

  it("a Skills Wiki learning's body is unchanged by the parameter", async () => {
    const { at, item } = await owned(SKILL);
    await rejectItem(at, item, ADA, "wrong tone", AT);
    const [learning] = await collectLearnings(at, AT);
    expect(learning?.body).toBe("In workflow 'draft', a person rejected the memo.edit call that followed this skill's judgment. Their reason: \"wrong tone\". Next time, judge similar input the way this correction shows.");
  });

  it("rule candidates are never sent to Skills Wiki", async () => {
    const { at, fake, item } = await owned();
    await rejectItem(at, item, ADA, "wrong tone", AT);
    await collectRuleCandidates(at, AT);
    expect(await submitLearnings(at, (await loadState(at))?.skillswiki?.url, AT)).toEqual([]);
    expect(await callTool({ url: fake.url, key: fake.key }, "learning_list", { pack: "demo" })).toMatchObject({ ok: true, value: { learnings: [] } });
  });

  it("a rejected agent_call becomes a candidate with its reason (a synthetic item: no shape uses agent_call)", async () => {
    const at = await runnerHome();
    await saveWritten(at, { skill_folders: [{ workflow: "store", path: `${at}/skills/store`, root: `${at}/skills` }] });
    const created = await requestApproval(at, { prepared: prepareAgentCall("publish", "mcp__shop__update", { id: 1 }), via: "runner", run: { workflow: "store", run_id: "r1", step: "publish" }, why: "Publish it" }, AT);
    await rejectItem(at, created.id, { name: "Owner", role: "decision_maker" }, "Not this product", AT);
    const [found] = await collectRuleCandidates(at, AT);
    expect(found?.body).toBe("In workflow 'store', a person rejected the mcp__shop__update call in step 'publish'. Their reason: \"Not this product\".");
  });

  it("an approval the agent tried to decide (refused) makes no candidate", async () => {
    const { at, item } = await owned();
    await expect(refuseDecision(at, await getApproval(at, item, AT), "agent", "Approvals are decided by a person", AT, "agent")).rejects.toThrow();
    expect(await collectRuleCandidates(at, AT)).toEqual([]);
  });
});
