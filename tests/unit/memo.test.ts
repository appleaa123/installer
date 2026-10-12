import { describe, expect, it } from "vitest";
import { approveItem, editItem } from "../../src/core/approvals.js";
import { MEMOS_DIR } from "../../src/core/memo.js";
import { replaceRecord } from "../../src/core/numbered.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, prepareAction, requireTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { fixedClock } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const MEMBER = { name: "terminal", role: "member" } as const;
const BOSS = { name: "Owner", role: "decision_maker" } as const;

async function withMemo(): Promise<ToolContext> {
  const ctx = await toolContext(await makeTempHome(), "cli", DEFAULT_TOOLS, fixedClock("2026-10-08T12:00:00.000Z"));
  await invokeTool(ctx, "memo.add", { text: "Call back on Friday" });
  return ctx;
}

async function tokenFor(ctx: ToolContext, tool: string, args: Record<string, unknown>, decider: typeof MEMBER | typeof BOSS): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool, args, why: "The memo is out of date." });
  await approveItem(ctx.home, item.id as number, decider, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

describe("memo tools (D63)", () => {
  it("adds (L1) and lists (L0) without approval", async () => {
    const ctx = await withMemo();
    await expect(invokeTool(ctx, "memo.list", {})).resolves.toEqual({ memos: [{ id: 1, text: "Call back on Friday", at: "2026-10-08T12:00:00.000Z" }] });
  });

  it("edits (L2) only with a member's approval of that exact text", async () => {
    const ctx = await withMemo();
    await expect(invokeTool(ctx, "memo.edit", { id: 1, text: "Call back on Monday" })).rejects.toThrow("memo.edit is L2");
    const token = await tokenFor(ctx, "memo.edit", { id: 1, text: "Call back on Monday" }, MEMBER);
    await expect(invokeTool(ctx, "memo.edit", { id: 1, text: "Call back on Monday", approval_token: token })).resolves.toMatchObject({ id: 1, text: "Call back on Monday" });
  });

  it("deletes (L3, irreversible) only with the decision maker's approval", async () => {
    const ctx = await withMemo();
    const item = await invokeTool(ctx, "approvals.request", { tool: "memo.delete", args: { id: 1 }, why: "Done." });
    expect(item).toMatchObject({ level: "L3", required_role: "decision_maker", expected_values: { text: "Call back on Friday" } });
    const token = await tokenFor(ctx, "memo.delete", { id: 1 }, BOSS);
    await expect(invokeTool(ctx, "memo.delete", { id: 1, approval_token: token })).resolves.toEqual({ deleted: true, id: 1 });
    await expect(invokeTool(ctx, "memo.list", {})).resolves.toEqual({ memos: [] });
  });

  it("refuses an approved edit when the memo changed after approval (expected value in the hash, §9.6)", async () => {
    const ctx = await withMemo();
    const token = await tokenFor(ctx, "memo.edit", { id: 1, text: "Call back on Monday" }, MEMBER);
    await replaceRecord(ctx.home, MEMOS_DIR, { id: 1, text: "Someone else changed this", at: ctx.now() });
    await expect(invokeTool(ctx, "memo.edit", { id: 1, text: "Call back on Monday", approval_token: token })).rejects.toThrow("differs from approval");
  });

  it("runs the person's edited version, not the agent's", async () => {
    const ctx = await withMemo();
    const item = await invokeTool(ctx, "approvals.request", { tool: "memo.edit", args: { id: 1, text: "Agent wording" }, why: "Update." });
    const mine = await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "Person's wording" });
    await editItem(ctx.home, item.id as number, mine, MEMBER, ctx.now());
    const got = await invokeTool(ctx, "approvals.get", { id: item.id });
    expect(got).toMatchObject({ status: "approved", action: { args: { id: 1, text: "Person's wording" } } });
    await expect(invokeTool(ctx, "memo.edit", { id: 1, text: "Agent wording", approval_token: got.approval_token })).rejects.toThrow("differs from approval");
    await expect(invokeTool(ctx, "memo.edit", { id: 1, text: "Person's wording", approval_token: got.approval_token })).resolves.toMatchObject({ text: "Person's wording" });
  });

  it.each([
    ["memo.add", { text: "" }, "memo.add needs 'text' as non-empty text"],
    ["memo.add", { text: "x".repeat(2001) }, "longer than 2000 characters"],
    ["memo.edit", { id: 0, text: "x" }, "memo.edit needs 'id' as a whole number from 1"],
    ["memo.edit", { id: 9, text: "x" }, "No memo 9"],
    ["memo.delete", { id: 1, force: true }, "memo.delete does not take 'force'"],
  ])("%s refuses %j", async (tool, args, message) => {
    const ctx = await withMemo();
    await expect(invokeTool(ctx, tool, args)).rejects.toThrow(message);
  });

  it("does not show the token in approvals.list, only through approvals.get once approved", async () => {
    const ctx = await withMemo();
    await tokenFor(ctx, "memo.edit", { id: 1, text: "New" }, MEMBER);
    const listed = await invokeTool(ctx, "approvals.list", { status: "approved" });
    expect(JSON.stringify(listed)).not.toContain("token");
    await expect(invokeTool(ctx, "approvals.list", { status: "pending" })).resolves.toEqual({ items: [] });
  });
});
