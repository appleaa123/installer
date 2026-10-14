import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveItem, ToolRefusal } from "../../src/core/approvals.js";
import { APPROVAL_TOOLS } from "../../src/core/approval-tools.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import type { FieldTag, TagSource } from "../../src/core/levels.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { createRegistry, describeTools, invokeTool, onlyKeys, type ToolContext, type ToolDef } from "../../src/core/tools.js";
import { fixedClock } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const MEMBER = { name: "terminal", role: "member" } as const;
const BOSS = { name: "Owner", role: "decision_maker" } as const;

/** Test-only tag source (D59): demo.set writes item.<field>; amount is financial. */
const TAGGED: Readonly<Record<string, readonly FieldTag[]>> = { "item.amount": ["financial"] };
const TAGS: TagSource = (field) => TAGGED[`${field.entity}.${field.field}`] ?? [];

function demoTools(ran: string[]): ToolDef[] {
  const parse = (name: string) => (args: Readonly<Record<string, unknown>>) => {
    onlyKeys(args, ["field", "value"], name);
    return args;
  };
  return [
    { name: "demo.read", description: "read", fields: {}, required: [], level: "L0", parse: parse("demo.read"), run: async () => ({ read: ran.push("read") }) },
    { name: "demo.note", description: "note", fields: {}, required: [], level: "L1", parse: parse("demo.note"), run: async () => ({ noted: ran.push("note") }) },
    {
      name: "demo.set", description: "set", fields: { field: { type: "string" } }, required: [], level: "L1", parse: parse("demo.set"),
      writes: (args) => [{ entity: "item", field: String(args.field) }], run: async (_ctx, args) => ({ set: ran.push(`set ${String(args.field)}`) }),
    },
    { name: "demo.send", description: "send", fields: {}, required: [], parse: parse("demo.send"), run: async () => ({ sent: ran.push("send") }) },
    { name: "demo.flaky", description: "flaky", fields: {}, required: [], level: "L2", parse: parse("demo.flaky"), run: async () => {
      throw new ActionFailure("the far end is down");
    } },
  ];
}

async function context(rules: Record<string, "L0" | "L1" | "L2" | "L3"> = {}) {
  const ran: string[] = [];
  const home = await makeTempHome();
  const ctx: ToolContext = { home, now: fixedClock("2026-10-08T12:00:00.000Z"), via: "mcp", registry: createRegistry([...APPROVAL_TOOLS, ...demoTools(ran)]), tags: TAGS, rules };
  return { ctx, ran, home };
}

async function events(home: string): Promise<string[]> {
  try {
    return (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
  } catch {
    return [];
  }
}

/** The agent asks, a person approves in-process (the CLI decides in Task 5), the agent fetches the token. */
async function approvedToken(ctx: ToolContext, tool: string, args: Record<string, unknown>, decider: typeof MEMBER | typeof BOSS = MEMBER): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool, args, why: "Needed for the test." });
  await approveItem(ctx.home, item.id as number, decider, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

describe("the tool gate (§11.1)", () => {
  it("runs an L0 tool without a token or an audit line", async () => {
    const { ctx, ran, home } = await context();
    await expect(invokeTool(ctx, "demo.read", {})).resolves.toEqual({ read: 1 });
    expect(ran).toEqual(["read"]);
    expect(await events(home)).toEqual([]);
  });

  it("runs an L1 tool without a token and logs it", async () => {
    const { ctx, home } = await context();
    await invokeTool(ctx, "demo.note", {});
    expect(await events(home)).toEqual(["tool.executed"]);
  });

  it("refuses an L2 tool without a token, says how to ask, runs nothing and audits the refusal", async () => {
    const { ctx, ran, home } = await context();
    await expect(invokeTool(ctx, "demo.send", {})).rejects.toThrow(ToolRefusal);
    await expect(invokeTool(ctx, "demo.send", {})).rejects.toThrow('demo.send is L2 (no declared level (default L2)): a person must approve it first. Call approvals.request with {"tool":"demo.send","args":{},"why":"<why this is needed>"}');
    expect(ran).toEqual([]);
    expect(await events(home)).toEqual(["tool.refused", "tool.refused"]);
  });

  it("runs an approved call once with its token, then refuses the token", async () => {
    const { ctx, ran, home } = await context();
    const token = await approvedToken(ctx, "demo.send", {});
    await expect(invokeTool(ctx, "demo.send", { approval_token: token })).resolves.toEqual({ sent: 1 });
    await expect(invokeTool(ctx, "demo.send", { approval_token: token })).rejects.toThrow("Approval 1 was already used; request a new approval");
    expect(ran).toEqual(["send"]);
    expect(await events(home)).toEqual(["approval.requested", "approval.approved", "tool.executed", "tool.refused"]);
  });

  it("refuses a token used for different arguments", async () => {
    const { ctx, ran } = await context();
    const token = await approvedToken(ctx, "demo.set", { field: "amount", value: "10" }, BOSS);
    await expect(invokeTool(ctx, "demo.set", { field: "amount", value: "99", approval_token: token })).rejects.toThrow("differs from approval 1");
    expect(ran).toEqual([]);
  });

  it("never lets the model choose a level: an extra 'level' argument is refused", async () => {
    const { ctx } = await context();
    await expect(invokeTool(ctx, "demo.send", { level: "L0" })).rejects.toThrow("demo.send does not take 'level'");
    await expect(invokeTool(ctx, "approvals.request", { tool: "demo.send", args: {}, why: "x", level: "L0" })).rejects.toThrow(InputError);
  });

  it("raises a write of a financial field to L3, which only the decision maker can approve (test tag source)", async () => {
    const { ctx, ran } = await context();
    await expect(invokeTool(ctx, "demo.set", { field: "name" })).resolves.toEqual({ set: 1 });
    await expect(invokeTool(ctx, "demo.set", { field: "amount" })).rejects.toThrow("demo.set is L3 (writes item.amount (financial))");
    const item = await invokeTool(ctx, "approvals.request", { tool: "demo.set", args: { field: "amount" }, why: "Correct the figure." });
    expect(item).toMatchObject({ level: "L3", required_role: "decision_maker", next: expect.stringContaining("Ask the decision maker to run 'taskpilot approvals approve 1'") });
    await expect(approveItem(ctx.home, 1, MEMBER, ctx.now())).rejects.toThrow("needs the decision maker");
    await approveItem(ctx.home, 1, BOSS, ctx.now());
    const token = (await invokeTool(ctx, "approvals.get", { id: 1 })).approval_token;
    await expect(invokeTool(ctx, "demo.set", { field: "amount", approval_token: token })).resolves.toEqual({ set: 2 });
    expect(ran).toEqual(["set name", "set amount"]);
  });

  it("applies a client rule that raises a tool to L2", async () => {
    const { ctx } = await context({ "demo.note": "L2" });
    await expect(invokeTool(ctx, "demo.note", {})).rejects.toThrow("demo.note is L2 (client rule L2)");
  });

  it("keeps approvals tools at L0 whatever a client rule says", async () => {
    const { ctx } = await context({ "approvals.list": "L3" });
    await expect(invokeTool(ctx, "approvals.list", {})).resolves.toEqual({ items: [] });
  });

  it("logs a failure after a spent token, and the token stays spent", async () => {
    const { ctx, home } = await context();
    const token = await approvedToken(ctx, "demo.flaky", {});
    await expect(invokeTool(ctx, "demo.flaky", { approval_token: token })).rejects.toThrow("the far end is down");
    await expect(invokeTool(ctx, "demo.flaky", { approval_token: token })).rejects.toThrow("already used");
    expect((await events(home)).slice(-2)).toEqual(["tool.failed", "tool.refused"]);
  });

  it.each([["an unknown tool", "demo.nothing", {}, "Unknown tool 'demo.nothing'. Tools: approvals.request"], ["a list instead of an object", "demo.read", [], "Tool arguments must be a JSON object"], ["a token on an approvals tool", "approvals.list", { approval_token: "x" }, "approvals.list takes no approval_token"]])(
    "refuses %s as a usage error",
    async (_name, tool, args, message) => {
      const { ctx } = await context();
      await expect(invokeTool(ctx, tool, args)).rejects.toThrow(InputError);
      await expect(invokeTool(ctx, tool, args)).rejects.toThrow(message);
    },
  );

  it("refuses approvals.request for an action that needs none, or for an approvals tool", async () => {
    const { ctx } = await context();
    await expect(invokeTool(ctx, "approvals.request", { tool: "demo.note", args: {}, why: "x" })).rejects.toThrow("demo.note is L1 and needs no approval: call it directly");
    await expect(invokeTool(ctx, "approvals.request", { tool: "approvals.list", args: {}, why: "x" })).rejects.toThrow("approvals.list needs no approval");
  });
});

describe("the default tool set", () => {
  it("offers no way to decide an approval: deciding is for a person at the terminal (D61)", () => {
    expect([...DEFAULT_TOOLS.keys()]).toEqual([
      "approvals.request", "approvals.list", "approvals.get", "memo.list", "memo.add", "memo.edit", "memo.delete",
      "records.find", "records.get", "records.create", "records.update", "records.preview_import", "records.import",
      "channel.list", "channel.inbox", "channel.notify", "channel.send",
    ]);
  });

  it("adds an optional approval_token to every gated tool's schema, and to no approvals tool", () => {
    const listed = describeTools(DEFAULT_TOOLS);
    const withToken = listed.filter((tool) => JSON.stringify(tool.inputSchema).includes('"approval_token"')).map((tool) => tool.name);
    expect(withToken).toEqual(["memo.list", "memo.add", "memo.edit", "memo.delete", "records.find", "records.get", "records.create", "records.update", "records.preview_import", "records.import", "channel.list", "channel.inbox", "channel.notify", "channel.send"]);
  });

  it("refuses a registry with a duplicate or badly named tool", () => {
    const tool = demoTools([])[0] as ToolDef;
    expect(() => createRegistry([tool, tool])).toThrow("Tool 'demo.read' is defined twice");
    expect(() => createRegistry([{ ...tool, name: "Read" }])).toThrow("must look like 'group.action'");
  });
});
