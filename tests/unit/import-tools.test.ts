import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { InputError } from "../../src/core/inputs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { connectedHome, sheetRows, useFakeGoogle } from "../helpers/data-home.js";
import { startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { fixedClock } from "../helpers/memory-deps.js";

const MEMBER = { name: "terminal", role: "member" } as const;
const BOSS = { name: "Owner", role: "decision_maker" } as const;
const ADA = ["Ada", "ada@example.com", "", "0", "kept"];
const GRACE = ["Grace", "grace@example.com", "met in May", "12.50", ""];
let fake: FakeGoogle;
let sheets = 0;

beforeAll(async () => {
  fake = await startFakeGoogle();
  await useFakeGoogle(fake);
});

afterAll(() => {
  vi.unstubAllEnvs();
  fake.stop();
});

async function setup(): Promise<{ ctx: ToolContext; id: string }> {
  sheets += 1;
  const id = `import-${sheets}`;
  const home = await connectedHome(fake, id, [ADA, GRACE]);
  return { ctx: await toolContext(home, "cli", DEFAULT_TOOLS, fixedClock("2026-10-08T12:00:00.000Z")), id };
}

async function approved(ctx: ToolContext, args: Record<string, unknown>, decider: typeof MEMBER | typeof BOSS): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool: "records.import", args, why: "The person uploaded their list." });
  await approveItem(ctx.home, item.id as number, decider, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

const ADDS = { entity: "contact", rows: [{ name: "Linus", email: "linus@example.com" }, { name: "Ken", email: "ken@example.com", notes: "new" }] };
const MIXED = { entity: "contact", rows: [{ email: "ada@example.com", notes: "prefers email" }, { name: "Grace", email: "grace@example.com", notes: "met in May" }, { name: "Linus", email: "linus@example.com" }] };

describe("records.preview_import (L0, D71)", () => {
  it("shows new, changed (from → to) and unchanged rows, and that adding only is L2", async () => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.preview_import", ADDS)).resolves.toMatchObject({ new: ADDS.rows, changed: [], unchanged: 0, conflicting: [], level: "L2" });
    await expect(invokeTool(ctx, "records.preview_import", MIXED)).resolves.toMatchObject({
      new: [{ name: "Linus", email: "linus@example.com" }],
      changed: [{ key: "ada@example.com", from: { notes: "" }, to: { notes: "prefers email" } }],
      unchanged: 1, conflicting: [], level: "L3", reasons: ["floor: irreversible"],
    });
  });

  it("lists conflicting rows: a repeated key, a missing key, an invalid value, a missing required field", async () => {
    const { ctx } = await setup();
    const rows = [{ name: "A", email: "a@example.com" }, { name: "A2", email: "A@example.com" }, { name: "B" }, { name: "C", email: "c-at-example" }, { email: "d@example.com" }];
    await expect(invokeTool(ctx, "records.preview_import", { entity: "contact", rows })).resolves.toMatchObject({
      level: null,
      conflicting: [
        { row: 2, key: "a@example.com", reason: "repeats the email of import row 1" },
        { row: 3, reason: "has no email" },
        { row: 4, key: "c-at-example", reason: "contact.email must be an email address" },
        { row: 5, key: "d@example.com", reason: "contact needs 'name'" },
      ],
    });
  });

  it("shows a change of a financial field as L3 (§9.3)", async () => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.preview_import", { entity: "contact", rows: [{ name: "Z", email: "z@example.com", balance: "5.00" }] })).resolves.toMatchObject({ level: "L3", reasons: ["writes contact.balance (financial)"] });
  });

  it.each([[[]], [Array.from({ length: 501 }, () => ({ email: "x@example.com" }))], [["not an object"]]])("refuses %#: rows must be 1 to 500 objects", async (rows) => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.preview_import", { entity: "contact", rows })).rejects.toThrow("records.preview_import needs 'rows': a list of 1 to 500 objects of field names to text");
  });
});

describe("records.import (D71)", () => {
  it("adds records as L2 with a member's approval, in one append", async () => {
    const { ctx, id } = await setup();
    await expect(invokeTool(ctx, "records.import", ADDS)).rejects.toThrow("records.import is L2");
    const token = await approved(ctx, ADDS, MEMBER);
    await expect(invokeTool(ctx, "records.import", { ...ADDS, approval_token: token })).resolves.toEqual({ entity: "contact", created: 2, changed: 0, unchanged: 0 });
    expect((await sheetRows(fake, id)).slice(3)).toEqual([["Linus", "linus@example.com", "", "", ""], ["Ken", "ken@example.com", "new", "", ""]]);
  });

  it("needs the decision maker to overwrite existing records, then writes exactly the preview", async () => {
    const { ctx, id } = await setup();
    await expect(invokeTool(ctx, "records.import", MIXED)).rejects.toThrow("records.import is L3 (floor: irreversible)");
    const item = await invokeTool(ctx, "approvals.request", { tool: "records.import", args: MIXED, why: "Merge the list." });
    await expect(approveItem(ctx.home, item.id as number, MEMBER, ctx.now())).rejects.toThrow("needs the decision maker");
    await approveItem(ctx.home, item.id as number, BOSS, ctx.now());
    const token = (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token;
    await expect(invokeTool(ctx, "records.import", { ...MIXED, approval_token: token })).resolves.toEqual({ entity: "contact", created: 1, changed: 1, unchanged: 1 });
    expect(await sheetRows(fake, id)).toEqual([
      ["Full name", "E-mail", "Notes", "Balance", "Owner"], ["Ada", "ada@example.com", "prefers email", "0", "kept"], GRACE, ["Linus", "linus@example.com", "", "", ""],
    ]);
  });

  it("refuses an approved add-only import once one of its records exists in the sheet (§9.6)", async () => {
    const { ctx, id } = await setup();
    const token = await approved(ctx, ADDS, MEMBER);
    await fake.debug(`/debug/sheets/${id}`, { title: id, tabs: { People: [...(await sheetRows(fake, id)), ["Linus", "linus@example.com"]] } });
    await expect(invokeTool(ctx, "records.import", { ...ADDS, approval_token: token })).rejects.toThrow("differs from approval 1");
    expect(await sheetRows(fake, id)).toHaveLength(4);
  });

  it("refuses to import or ask about conflicting rows", async () => {
    const { ctx } = await setup();
    const args = { entity: "contact", rows: [{ name: "B" }] };
    await expect(invokeTool(ctx, "approvals.request", { tool: "records.import", args, why: "x" })).rejects.toThrow(InputError);
    await expect(invokeTool(ctx, "records.import", args)).rejects.toThrow("Fix the 1 conflicting row(s) first (records.preview_import lists them); import row 1 has no email");
  });
});
