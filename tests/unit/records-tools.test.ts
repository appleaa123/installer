import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveItem, ToolRefusal } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { removeMapping, saveMapping } from "../../src/core/data-source.js";
import { ActionFailure } from "../../src/core/failure.js";
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

/** A fresh sheet with Ada, a blank row and Grace, and a tool context on a home connected to it. */
async function setup(rows: readonly (readonly string[])[] = [ADA, [], GRACE]): Promise<{ ctx: ToolContext; id: string }> {
  sheets += 1;
  const id = `records-${sheets}`;
  const home = await connectedHome(fake, id, rows);
  return { ctx: await toolContext(home, "mcp", DEFAULT_TOOLS, fixedClock("2026-10-08T12:00:00.000Z")), id };
}

async function approved(ctx: ToolContext, tool: string, args: Record<string, unknown>, decider: typeof MEMBER | typeof BOSS = MEMBER): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool, args, why: "The person asked for it." });
  await approveItem(ctx.home, item.id as number, decider, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

describe("records.find and records.get (L0, §9.5)", () => {
  it("lists the mapped fields of every non-blank row, without asking anyone", async () => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.find", { entity: "contact" })).resolves.toEqual({
      entity: "contact", total: 2,
      records: [{ name: "Ada", email: "ada@example.com", notes: "", balance: "0" }, { name: "Grace", email: "grace@example.com", notes: "met in May", balance: "12.50" }],
    });
    expect((await readFile(join(ctx.home, AUDIT_FILE), "utf8").catch(() => "")).trim()).toBe("");
  });

  it("matches fields exactly, ignoring case, and honours the limit", async () => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.find", { entity: "contact", where: { name: "GRACE" } })).resolves.toMatchObject({ total: 1, records: [{ email: "grace@example.com" }] });
    await expect(invokeTool(ctx, "records.find", { entity: "contact", limit: 1 })).resolves.toMatchObject({ total: 2, records: [{ name: "Ada" }] });
  });

  it("gets one record by its key", async () => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "records.get", { entity: "contact", key: "Grace@Example.com" })).resolves.toMatchObject({ record: { name: "Grace", balance: "12.50" } });
  });

  it.each([
    ["an unknown key", "records.get", { entity: "contact", key: "nobody@example.com" }, "No contact with email 'nobody@example.com'"],
    ["an unknown entity", "records.find", { entity: "order" }, "No entity 'order' in the data contract"],
    ["a field that is not mapped", "records.find", { entity: "contact", where: { owner: "x" } }, "'owner' is not a mapped field of contact"],
    ["a limit over 100", "records.find", { entity: "contact", limit: 500 }, "'limit' must be a whole number from 1 to 100"],
  ])("refuses %s as a usage error", async (_name, tool, args, message) => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, tool, args)).rejects.toThrow(InputError);
    await expect(invokeTool(ctx, tool, args)).rejects.toThrow(message);
  });

  it("refuses to guess when a key appears twice in the sheet (Review Focus 2)", async () => {
    const { ctx } = await setup([ADA, ["Ada again", "ADA@example.com"]]);
    await expect(invokeTool(ctx, "records.get", { entity: "contact", key: "ada@example.com" })).rejects.toThrow(ActionFailure);
    await expect(invokeTool(ctx, "records.get", { entity: "contact", key: "ada@example.com" })).rejects.toThrow("The email 'ada@example.com' appears in rows 2 and 3 of the contact sheet: remove the extra copy first");
  });

  it("says to map again when a mapped column was removed from the sheet", async () => {
    const { ctx, id } = await setup();
    await fake.debug(`/debug/sheets/${id}`, { title: id, tabs: { People: [["Full name", "Mail"], ["Ada", "ada@example.com"]] } });
    await expect(invokeTool(ctx, "records.find", { entity: "contact" })).rejects.toThrow("Column 'E-mail' (contact.email) is no longer in row 1 of the sheet: run 'installer map contact' again");
  });

  it("says what to run when the entity is not mapped yet", async () => {
    const { ctx } = await setup();
    await removeMapping(ctx.home, "contact");
    await expect(invokeTool(ctx, "records.find", { entity: "contact" })).rejects.toThrow("The columns of 'contact' are not mapped yet: run 'installer map contact' first");
  });
});

describe("records.create and records.update (L2, tags, §9.6)", () => {
  it("refuses a new record without approval, then appends exactly the approved one", async () => {
    const { ctx, id } = await setup();
    const args = { entity: "contact", values: { name: "Linus", email: "linus@example.com" } };
    await expect(invokeTool(ctx, "records.create", args)).rejects.toThrow("records.create is L2 (no declared level (default L2)): a person must approve it first");
    const token = await approved(ctx, "records.create", args);
    await expect(invokeTool(ctx, "records.create", { ...args, approval_token: token })).resolves.toEqual({ entity: "contact", created: { name: "Linus", email: "linus@example.com" } });
    expect((await sheetRows(fake, id)).at(-1)).toEqual(["Linus", "linus@example.com", "", "", ""]);
  });

  it("raises a write of the financial field to L3: only the decision maker can approve it (§9.3)", async () => {
    const { ctx } = await setup();
    const args = { entity: "contact", key: "ada@example.com", values: { balance: "40.00" } };
    await expect(invokeTool(ctx, "records.update", args)).rejects.toThrow("records.update is L3 (writes contact.balance (financial))");
    const item = await invokeTool(ctx, "approvals.request", { tool: "records.update", args, why: "Correct the balance." });
    expect(item).toMatchObject({ level: "L3", required_role: "decision_maker", expected_values: { current: { balance: "0" } } });
    await expect(approveItem(ctx.home, item.id as number, MEMBER, ctx.now())).rejects.toThrow("needs the decision maker");
  });

  it("changes only the approved fields and keeps the other columns of the row", async () => {
    const { ctx, id } = await setup();
    const args = { entity: "contact", key: "ada@example.com", values: { notes: "prefers email" } };
    const token = await approved(ctx, "records.update", args);
    await expect(invokeTool(ctx, "records.update", { ...args, approval_token: token })).resolves.toMatchObject({ record: { name: "Ada", notes: "prefers email" } });
    expect((await sheetRows(fake, id))[1]).toEqual(["Ada", "ada@example.com", "prefers email", "0", "kept"]);
  });

  it("refuses an approved update after someone changed that field in the sheet, and writes nothing (§9.6)", async () => {
    const { ctx, id } = await setup();
    const args = { entity: "contact", key: "grace@example.com", values: { notes: "call back" } };
    const token = await approved(ctx, "records.update", args);
    const edited = ["Grace", "grace@example.com", "edited by hand", "12.50", ""];
    await fake.debug(`/debug/sheets/${id}`, { title: id, tabs: { People: [(await sheetRows(fake, id))[0] ?? [], ADA, [], edited] } });
    await expect(invokeTool(ctx, "records.update", { ...args, approval_token: token })).rejects.toThrow(ToolRefusal);
    await expect(invokeTool(ctx, "records.update", { ...args, approval_token: token })).rejects.toThrow("This call differs from approval 1 (the tool, its arguments or the current values changed); request a new approval");
    expect((await sheetRows(fake, id))[3]).toEqual(edited);
  });

  it.each([
    ["a malformed email", "records.create", { entity: "contact", values: { name: "X", email: "x-at-example" } }, "contact.email must be an email address"],
    ["a key that already exists", "records.create", { entity: "contact", values: { name: "Ada", email: "ADA@example.com" } }, "contact 'ADA@example.com' already exists: use records.update"],
    ["a change of the key", "records.update", { entity: "contact", key: "ada@example.com", values: { email: "new@example.com" } }, "contact's key 'email' cannot be changed"],
    ["an unknown record", "records.update", { entity: "contact", key: "nobody@example.com", values: { notes: "x" } }, "No contact with email 'nobody@example.com'"],
  ])("refuses %s before anyone is asked", async (_name, tool, args, message) => {
    const { ctx } = await setup();
    await expect(invokeTool(ctx, "approvals.request", { tool, args, why: "Needed." })).rejects.toThrow(message);
    await expect(invokeTool(ctx, tool, args)).rejects.toThrow(InputError);
  });

  it("refuses a write of a field the mapping leaves out", async () => {
    const { ctx } = await setup();
    await saveMapping(ctx.home, { entity: "contact", columns: { name: "Full name", email: "E-mail" } });
    await expect(invokeTool(ctx, "records.update", { entity: "contact", key: "ada@example.com", values: { notes: "x" } })).rejects.toThrow("contact.notes has no column in the sheet: map it with 'installer map contact' first");
  });
});
