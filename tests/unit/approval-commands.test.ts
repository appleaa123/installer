import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalsCommand, type ApprovalsCommand } from "../../src/core/approval-commands.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { InputError } from "../../src/core/inputs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { fixedClock } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const ROLES = { decision_maker: "Owner" };

/** A home with memo 1 and two requests: 1 = edit it (L2), 2 = delete it (L3). */
async function queue() {
  const now = fixedClock("2026-10-08T12:00:00.000Z");
  const ctx = await toolContext(await makeTempHome(), "mcp", DEFAULT_TOOLS, now);
  await invokeTool(ctx, "memo.add", { text: "Draft" });
  await invokeTool(ctx, "approvals.request", { tool: "memo.edit", args: { id: 1, text: "Final" }, why: "Ready." });
  await invokeTool(ctx, "approvals.request", { tool: "memo.delete", args: { id: 1 }, why: "Not needed." });
  const run = (command: Partial<ApprovalsCommand>) => approvalsCommand(ctx.home, ROLES, { sub: undefined, id: undefined, interactive: true, ...command }, now);
  return { ctx, run };
}

describe("installer approvals (D61)", () => {
  it("lists every item without its token", async () => {
    const { run } = await queue();
    const listed = (await run({ sub: "list" })) as { items: { id: number; status: string }[] };
    expect(listed.items.map((item) => [item.id, item.status])).toEqual([[1, "pending"], [2, "pending"]]);
  });

  it("approve: a member approves L2 and is told to hand back to the agent; the token is not printed", async () => {
    const { run } = await queue();
    const result = await run({ sub: "approve", id: "1" });
    expect(result).toMatchObject({ id: 1, status: "approved", decision: { by: "terminal", role: "member" }, next: expect.stringContaining("Tell the agent that item 1 is approved") });
    expect(result).not.toHaveProperty("token");
  });

  it("approve: L3 needs --as with the decision maker's name from the MODE phase", async () => {
    const { run } = await queue();
    await expect(run({ sub: "approve", id: "2", as: "Sam" })).rejects.toThrow("needs the decision maker");
    await expect(run({ sub: "approve", id: "2", as: "owner" })).resolves.toMatchObject({ status: "approved", decision: { by: "owner", role: "decision_maker" } });
  });

  it("reject keeps the reason", async () => {
    const { run } = await queue();
    await expect(run({ sub: "reject", id: "1", reason: "Wrong memo" })).resolves.toMatchObject({ status: "rejected", decision: { reason: "Wrong memo" } });
  });

  it("edit checks the person's arguments with the tool's own rules, then approves them", async () => {
    const { run } = await queue();
    await expect(run({ sub: "edit", id: "1" })).rejects.toThrow("edit needs --value");
    await expect(run({ sub: "edit", id: "1", value: "{" })).rejects.toThrow("--value must be the tool's arguments as JSON");
    await expect(run({ sub: "edit", id: "1", value: '{"id":1}' })).rejects.toThrow("memo.edit needs 'text' as non-empty text");
    await expect(run({ sub: "edit", id: "1", value: '{"id":1,"text":"Final, edited"}' })).resolves.toMatchObject({ status: "approved", action: { args: { id: 1, text: "Final, edited" } }, decision: { decision: "edited" } });
  });

  it("refuses a decision typed where no terminal is attached (an agent's shell), audits it, and leaves the item pending", async () => {
    const { ctx, run } = await queue();
    await expect(run({ sub: "approve", id: "1", interactive: false })).rejects.toThrow("Approvals are decided by a person in their own terminal, not by the agent: open a terminal and run 'installer approvals approve 1' there");
    const last = (await readFile(join(ctx.home, AUDIT_FILE), "utf8")).trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(last)).toMatchObject({ event: "approval.refused", actor: "agent", ref: "approval:1" });
    await expect(run({ sub: "list" })).resolves.toMatchObject({ items: [{ id: 1, status: "pending" }, { id: 2 }] });
  });

  it.each([[{ sub: "approve", id: "x" }], [{ sub: "approve", id: undefined }], [{ sub: "close", id: "1" }], [{ sub: undefined }]])("refuses %j as a usage error", async (command) => {
    const { run } = await queue();
    await expect(run(command)).rejects.toThrow(InputError);
    await expect(run(command)).rejects.toThrow("approvals needs one of: list, approve <id>");
  });
});
