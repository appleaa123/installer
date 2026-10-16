import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { WorkflowError, loadWorkflow, parseWorkflow, workflowIds } from "../../src/core/workflow.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA, MEMO_DIGEST, writeWorkflow } from "../helpers/workflow-home.js";

const parse = (value: unknown, id = "memo-digest") => parseWorkflow(value, id, DEFAULT_TOOLS);
const withSteps = (steps: unknown[], extra: Record<string, unknown> = {}) => ({ ...MEMO_DIGEST, ...extra, steps });

describe("workflow files (§10.1, D81)", () => {
  it("reads typed steps with their modifiers and the trigger, with defaults filled in", () => {
    const workflow = parse(MEMO_DIGEST);
    expect(workflow.trigger).toEqual({ kind: "cron", cron: "0 8 * * 1-5", tz: "America/Toronto", tolerance_minutes: 5 });
    expect(workflow.steps).toEqual([
      { id: "memos", kind: "tool", tool: "memo.list", args: {} },
      { id: "sort", kind: "judge", foreach: "${memos.memos}", judge: { instructions: "Say whether this memo needs action now or later.", input: "${item.text}", schema: LABEL_SCHEMA, context_tools: [], max_tool_calls: 3 } },
      { id: "note", kind: "tool", when: "len(sort) > 0", tool: "memo.add", args: { text: "Labels: ${sort[*].label}" } },
    ]);
  });

  it("reads approve steps, event and manual triggers", () => {
    const approve = { id: "fix", approve: { tool: "memo.edit", args: { id: 1, text: "${event.text}" }, why: "A contact asked for it", urgent: true } };
    expect(parse(withSteps([approve], { trigger: { event: "message.received", from: "external", channel: "telegram" } }))).toMatchObject({
      trigger: { kind: "event", event: "message.received", from: "external", channel: "telegram" },
      steps: [{ id: "fix", kind: "approve", tool: "memo.edit", why: "A contact asked for it", urgent: true }],
    });
    expect(parse(withSteps([{ id: "memos", tool: "memo.list" }], { trigger: undefined })).trigger).toEqual({ kind: "manual" });
  });

  it("takes a step's arguments as one whole reference to an earlier step's object", () => {
    expect(parse(withSteps([{ id: "memos", tool: "memo.list" }, { id: "again", tool: "memo.add", args: "${memos}" }])).steps[1]).toMatchObject({ args: "${memos}" });
    expect(() => parse(withSteps([{ id: "memos", tool: "memo.list" }, { id: "again", tool: "memo.add", args: "text ${memos}" }]))).toThrow('must be an object, or one reference such as "${draft}"');
  });

  it("allows read-only context tools within the call budget", () => {
    const judge = { instructions: "Label it.", schema: LABEL_SCHEMA, context_tools: [{ tool: "memo.list", args: {} }], max_tool_calls: 1 };
    expect(parse(withSteps([{ id: "label", judge }])).steps[0]).toMatchObject({ judge: { context_tools: [{ tool: "memo.list", args: {} }], max_tool_calls: 1 } });
  });

  it.each([
    [withSteps([{ id: "a", tool: "memo.nothing" }]), "step 'a' names no known tool"],
    [withSteps([{ id: "a", tool: "approvals.get", args: { id: 1 } }]), "approval bookkeeping; use an approve step"],
    [withSteps([{ id: "a", tool: "memo.edit", args: { id: 1, text: "x", approval_token: "1.abc" } }]), "cannot carry an approval_token"],
    [withSteps([{ id: "a", tool: "memo.add", args: { text: "${item.text}" } }]), "refers to 'item', which is not an earlier step (item exists only in the arguments of a foreach step)"],
    [withSteps([{ id: "a", tool: "memo.add", args: { text: "${later.text}" } }, { id: "later", tool: "memo.list" }]), "step 'a' refers to 'later'"],
    [withSteps([{ id: "a", tool: "memo.list", foreach: "${a.memos}" }]), "step 'a' refers to 'a'"],
    [withSteps([{ id: "a", tool: "memo.list", when: "item.x == 1", foreach: "${run.id}" }]), "refers to 'item'"],
    [withSteps([{ id: "a", tool: "memo.add", args: { text: "${event.text}" } }]), "refers to 'event'"],
    [withSteps([{ id: "a", tool: "memo.list" }, { id: "a", tool: "memo.list" }]), "step id 'a' is used twice"],
    [withSteps([{ id: "item", tool: "memo.list" }]), "steps[0].id must be"],
    [withSteps([{ id: "a", tool: "memo.list", judge: {} }]), "exactly one of tool, judge, approve"],
    [withSteps([{ id: "a", approve: { tool: "memo.edit", args: {}, why: "x" }, foreach: "${run.id}" }]), "cannot use foreach"],
    [withSteps([{ id: "a", approve: { tool: "memo.edit", args: {} } }]), "approve.why must be non-empty text"],
    [withSteps([{ id: "a", when: "len(", tool: "memo.list" }]), "Condition 'len('"],
    [withSteps([{ id: "a", tool: "memo.list", foreach: "items" }]), "foreach must be one reference"],
    [withSteps([{ id: "a", judge: { instructions: "x", schema: { type: "object", oneOf: [] } } }]), "uses 'oneOf'"],
    [withSteps([{ id: "a", judge: { instructions: "x", schema: LABEL_SCHEMA, context_tools: [{ tool: "memo.add", args: {} }] } }]), "not a read-only (L0) tool"],
    [withSteps([{ id: "a", judge: { instructions: "x", schema: LABEL_SCHEMA, context_tools: [{ tool: "memo.list" }], max_tool_calls: 0 } }]), "allows 0 calls"],
    [withSteps([{ id: "a", judge: { instructions: "x", schema: LABEL_SCHEMA, skill: "notes.md" } }]), "skill must be skillswiki:"],
    [withSteps([{ id: "a", judge: { instructions: "x", schema: LABEL_SCHEMA, min_confidence: 2 } }]), "min_confidence must be a number from 0 to 1"],
    [{ ...MEMO_DIGEST, trigger: { cron: "0 25 * * *", tz: "UTC" } }, "is not a 5-field cron expression"],
    [{ ...MEMO_DIGEST, trigger: { cron: "0 8 * * *", tz: "Mars/Base" } }, "is not an IANA time zone"],
    [{ ...MEMO_DIGEST, trigger: { cron: "0 8 * * *", tz: "UTC", tolerance_minutes: 0 } }, "tolerance_minutes must be"],
    [{ ...MEMO_DIGEST, trigger: { event: "message.received", from: "anyone" } }, "trigger.from must be one of external, member"],
    [{ ...MEMO_DIGEST, trigger: { webhook: "x" } }, "trigger must be"],
    [{ ...MEMO_DIGEST, mode: "agentic" }, "an agentic workflow has instructions and tools, not steps"],
    [{ ...MEMO_DIGEST, mode: "free" }, 'mode must be "typed" or "agentic"'],
    [{ ...MEMO_DIGEST, workflow: "other" }, "must be 'memo-digest', the name of its folder"],
    [{ ...MEMO_DIGEST, version: 0 }, "version must be"],
    [{ ...MEMO_DIGEST, steps: [] }, "steps must list at least one step"],
  ])("refuses a broken workflow (%#)", (value, message) => {
    expect(() => parse(value)).toThrow(WorkflowError);
    expect(() => parse(value)).toThrow(message);
  });
});

describe("workflows in the engine home", () => {
  it("loads workflows/<id>/workflow.json and lists the ids", async () => {
    const home = await makeTempHome();
    expect(await workflowIds(home)).toEqual([]);
    await writeWorkflow(home, MEMO_DIGEST);
    await writeWorkflow(home, { ...MEMO_DIGEST, workflow: "another" });
    expect(await workflowIds(home)).toEqual(["another", "memo-digest"]);
    expect((await loadWorkflow(home, "memo-digest", DEFAULT_TOOLS)).version).toBe(1);
  });

  it("names the missing file, refuses a bad id and a file that is not JSON", async () => {
    const home = await makeTempHome();
    await expect(loadWorkflow(home, "nothing", DEFAULT_TOOLS)).rejects.toThrow("No workflow 'nothing': workflows/nothing/workflow.json does not exist");
    await expect(loadWorkflow(home, "../etc", DEFAULT_TOOLS)).rejects.toThrow("Name a workflow");
    await mkdir(join(home, "workflows", "broken"), { recursive: true });
    await writeFile(join(home, "workflows", "broken", "workflow.json"), "{ not json");
    await expect(loadWorkflow(home, "broken", DEFAULT_TOOLS)).rejects.toThrow("Workflow 'broken': workflow.json is not valid JSON");
  });
});

describe("a workflow's skills (9.12 item 2, D154)", () => {
  it("reads local folders and skillswiki references, and has none by default", () => {
    expect(parse(MEMO_DIGEST).skills).toEqual([]);
    expect(parse({ ...MEMO_DIGEST, skills: ["/x/.claude/skills/a", "skillswiki:p/s/SKILL.md"] }).skills).toEqual(["/x/.claude/skills/a", "skillswiki:p/s/SKILL.md"]);
  });

  it.each([
    [["relative/skill"], "must be a folder path from 'taskfollow skills'"],
    [["skillswiki:p"], "must be a folder path from 'taskfollow skills'"],
    [["/a", "/a"], "lists '/a' twice"],
    [Array.from({ length: 11 }, (_, index) => `/s/${index}`), "at most 10 skills"],
    ["/a", "skills must be a list"],
  ])("refuses %j", (skills, message) => {
    expect(() => parse({ ...MEMO_DIGEST, skills })).toThrow(message);
  });
});
