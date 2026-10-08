import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APPROVALS_DIR, ToolRefusal, actionHash, approveItem, deciderFor, editItem, getApproval, listApprovals, redeemToken, rejectItem, requestApproval,
  type PreparedAction,
} from "../../src/core/approvals.js";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { InputError } from "../../src/core/inputs.js";
import type { Level } from "../../src/core/levels.js";
import { claimOnce, listIds } from "../../src/core/numbered.js";
import { makeTempHome } from "../helpers/temp-home.js";

const T0 = "2026-10-08T12:00:00.000Z";
const LATER = "2026-10-08T13:00:00.000Z";
const NEXT_DAY = "2026-10-09T12:00:00.001Z";
const MEMBER = { name: "terminal", role: "member" } as const;
const BOSS = { name: "Owner", role: "decision_maker" } as const;

function prepared(args: Record<string, unknown> = { id: 1, text: "new" }, level: Level = "L2", expected: Record<string, unknown> = { text: "old" }): PreparedAction {
  return { tool: "memo.edit", args, expected_values: expected, level, reasons: [`declared ${level}`], action_hash: actionHash("memo.edit", args, expected) };
}

async function events(home: string): Promise<string[]> {
  const text = await readFile(join(home, AUDIT_FILE), "utf8");
  return text.trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
}

async function requested(level: Level = "L2"): Promise<{ home: string; id: number }> {
  const home = await makeTempHome();
  const item = await requestApproval(home, { prepared: prepared(undefined, level), why: "The text is out of date.", via: "mcp" }, T0);
  return { home, id: item.id };
}

describe("a token spent by a call that crashed before it was recorded (review finding 2)", () => {
  it("reads as used, not approved, and says so once in the audit", async () => {
    const { home, id } = await requested();
    await approveItem(home, id, MEMBER, LATER);
    expect(await claimOnce(home, APPROVALS_DIR, id)).toBe(true);
    await expect(getApproval(home, id, LATER)).resolves.toMatchObject({ status: "used" });
    await expect(listApprovals(home, LATER)).resolves.toMatchObject([{ id, status: "used" }]);
    expect((await events(home)).filter((event) => event === "approval.used")).toHaveLength(1);
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: true });
  });
});

describe("actionHash (§11.1, D58)", () => {
  it("is sha256 of the canonical tool, args and expected values, whatever the key order", () => {
    const hash = actionHash("memo.edit", { id: 1, text: "a" }, { text: "b" });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(actionHash("memo.edit", { text: "a", id: 1 }, { text: "b" })).toBe(hash);
    expect(actionHash("memo.edit", { id: 1, text: "a!" }, { text: "b" })).not.toBe(hash);
    expect(actionHash("memo.edit", { id: 1, text: "a" }, { text: "changed meanwhile" })).not.toBe(hash);
    expect(actionHash("memo.edit", { id: 1, text: "a" }, {})).not.toBe(actionHash("memo.edit", { id: 1, text: "a" }, { text: "b" }));
  });
});

describe("requestApproval (§11.5)", () => {
  it("creates a pending item with the derived level, the role it needs and a 24-hour expiry, and audits it", async () => {
    const home = await makeTempHome();
    const item = await requestApproval(home, { prepared: prepared(), why: " The text is out of date. ", evidence: ["memo 1"], via: "cli" }, T0);
    expect(item).toMatchObject({
      id: 1, source: { via: "cli" }, level: "L2", urgent: false, action: { tool: "memo.edit", args: { id: 1, text: "new" } },
      expected_values: { text: "old" }, action_hash: prepared().action_hash, preview: 'memo.edit {"id":1,"text":"new"}',
      why: "The text is out of date.", evidence: ["memo 1"], required_role: "member", created_at: T0, expires_at: "2026-10-09T12:00:00.000Z", status: "pending",
    });
    expect(item.token).toBeUndefined();
    expect(await events(home)).toEqual(["approval.requested"]);
  });

  it("asks for the decision maker on an L3 action", async () => {
    const { home, id } = await requested("L3");
    await expect(getApproval(home, id, T0)).resolves.toMatchObject({ level: "L3", required_role: "decision_maker" });
  });

  it.each([[""], ["   "]])("refuses a request without a why (%j) and creates nothing", async (why) => {
    const home = await makeTempHome();
    await expect(requestApproval(home, { prepared: prepared(), why, via: "mcp" }, T0)).rejects.toThrow("needs a why");
    await expect(listIds(home, APPROVALS_DIR)).resolves.toEqual([]);
  });

  it("refuses to queue an action that needs no approval", async () => {
    const home = await makeTempHome();
    await expect(requestApproval(home, { prepared: prepared(undefined, "L1"), why: "x", via: "mcp" }, T0)).rejects.toThrow("memo.edit is L1 and needs no approval: call it directly");
  });
});

describe("deciderFor (D60)", () => {
  it("makes the MODE phase's decision maker the decision maker, by name, ignoring case and spaces", () => {
    expect(deciderFor(" owner ", { decision_maker: "Owner" })).toEqual({ name: "owner", role: "decision_maker" });
    expect(deciderFor("Sam", { decision_maker: "Owner" })).toEqual({ name: "Sam", role: "member" });
    expect(deciderFor(undefined, { decision_maker: "Owner" })).toEqual({ name: "terminal", role: "member" });
    expect(deciderFor("Owner", undefined)).toEqual({ name: "Owner", role: "member" });
  });
});

describe("decisions (§11.5)", () => {
  it("approve issues a token bound to the item and audits the decision", async () => {
    const { home, id } = await requested();
    const item = await approveItem(home, id, MEMBER, LATER);
    expect(item).toMatchObject({ status: "approved", decision: { decision: "approved", by: "terminal", role: "member", at: LATER } });
    expect(item.token).toMatch(/^1\.[0-9a-f]{64}$/);
    expect(await events(home)).toEqual(["approval.requested", "approval.approved"]);
  });

  it("refuses a member's approval of an L3 item, audits the attempt, and lets the decision maker approve it", async () => {
    const { home, id } = await requested("L3");
    await expect(approveItem(home, id, MEMBER, LATER)).rejects.toThrow("Approval item 1 is L3 and needs the decision maker");
    await expect(getApproval(home, id, LATER)).resolves.toMatchObject({ status: "pending" });
    await expect(approveItem(home, id, BOSS, LATER)).resolves.toMatchObject({ status: "approved", decision: { role: "decision_maker" } });
    expect(await events(home)).toEqual(["approval.requested", "approval.refused", "approval.approved"]);
  });

  it("reject records the reason and issues no token", async () => {
    const { home, id } = await requested();
    const item = await rejectItem(home, id, MEMBER, " not now ", LATER);
    expect(item).toMatchObject({ status: "rejected", decision: { decision: "rejected", reason: "not now" } });
    expect(item.token).toBeUndefined();
  });

  it("edit approves the person's version: new arguments, new hash, the original kept", async () => {
    const { home, id } = await requested();
    const mine = prepared({ id: 1, text: "my words" });
    const item = await editItem(home, id, mine, MEMBER, LATER);
    expect(item).toMatchObject({ status: "approved", action: { tool: "memo.edit", args: { id: 1, text: "my words" } }, action_hash: mine.action_hash });
    expect(item.decision).toMatchObject({ decision: "edited", original: { tool: "memo.edit", args: { id: 1, text: "new" } } });
    expect(await events(home)).toEqual(["approval.requested", "approval.edited"]);
  });

  it("refuses an edit that raises the item to L3 unless the decision maker makes it", async () => {
    const { home, id } = await requested();
    await expect(editItem(home, id, prepared(undefined, "L3"), MEMBER, LATER)).rejects.toThrow("needs the decision maker");
    await expect(editItem(home, id, prepared(undefined, "L3"), BOSS, LATER)).resolves.toMatchObject({ level: "L3", required_role: "decision_maker" });
  });

  it("refuses an edit that changes the tool", async () => {
    const { home, id } = await requested();
    const other = { ...prepared(), tool: "memo.delete" };
    await expect(editItem(home, id, other, MEMBER, LATER)).rejects.toThrow("an edit can change its arguments, not the tool");
  });

  it("refuses a second decision on the same item and audits it", async () => {
    const { home, id } = await requested();
    await approveItem(home, id, MEMBER, LATER);
    await expect(rejectItem(home, id, MEMBER, undefined, LATER)).rejects.toThrow(InputError);
    await expect(rejectItem(home, id, MEMBER, undefined, LATER)).rejects.toThrow("Approval item 1 is approved, not pending");
    expect((await events(home)).at(-1)).toBe("approval.refused");
  });

  it("refuses a decision on an item that does not exist", async () => {
    await expect(approveItem(await makeTempHome(), 9, MEMBER, LATER)).rejects.toThrow("No approval item 9");
  });
});

describe("expiry (D62)", () => {
  it("expires an open item on the first read after expires_at, once, and refuses decisions on it", async () => {
    const { home, id } = await requested();
    await expect(listApprovals(home, NEXT_DAY)).resolves.toMatchObject([{ id, status: "expired" }]);
    await expect(listApprovals(home, NEXT_DAY)).resolves.toMatchObject([{ id, status: "expired" }]);
    expect(await events(home)).toEqual(["approval.requested", "approval.expired"]);
    await expect(approveItem(home, id, MEMBER, NEXT_DAY)).rejects.toThrow("is expired, not pending");
  });

  it("lists urgent pending items first", async () => {
    const home = await makeTempHome();
    await requestApproval(home, { prepared: prepared(), why: "a", via: "mcp" }, T0);
    await requestApproval(home, { prepared: prepared(), why: "b", urgent: true, via: "mcp" }, T0);
    expect((await listApprovals(home, LATER)).map((item) => item.id)).toEqual([2, 1]);
  });
});

describe("redeemToken (§11.1)", () => {
  async function approved(level: Level = "L2", decider: typeof MEMBER | typeof BOSS = MEMBER) {
    const { home, id } = await requested(level);
    const item = await approveItem(home, id, decider, LATER);
    return { home, token: item.token ?? "" };
  }

  it("accepts the exact approved action once, then refuses the same token", async () => {
    const { home, token } = await approved();
    await expect(redeemToken(home, token, prepared(), LATER)).resolves.toMatchObject({ status: "used", used_at: LATER });
    await expect(redeemToken(home, token, prepared(), LATER)).rejects.toThrow("Approval 1 was already used; request a new approval");
  });

  it("lets exactly one of several simultaneous calls with the same token through", async () => {
    const { home, token } = await approved();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => redeemToken(home, token, prepared(), LATER)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it.each([
    ["other arguments", prepared({ id: 1, text: "something else" })],
    ["a changed current value", prepared(undefined, "L2", { text: "edited meanwhile" })],
    ["another tool", { ...prepared(), tool: "memo.delete", action_hash: actionHash("memo.delete", { id: 1, text: "new" }, { text: "old" }) }],
  ])("refuses %s (hash mismatch) and keeps the token usable", async (_name, call) => {
    const { home, token } = await approved();
    await expect(redeemToken(home, token, call, LATER)).rejects.toThrow("differs from approval 1");
    await expect(redeemToken(home, token, prepared(), LATER)).resolves.toMatchObject({ status: "used" });
  });

  it.each([["garbage"], ["1.abc"], [`2.${"0".repeat(64)}`]])("refuses the token %s", async (bad) => {
    const { home } = await approved();
    await expect(redeemToken(home, bad, prepared(), LATER)).rejects.toThrow(ToolRefusal);
    await expect(redeemToken(home, bad, prepared(), LATER)).rejects.toThrow("does not match any approval");
  });

  it("refuses a forged token for a real item", async () => {
    const { home, token } = await approved();
    const forged = `1.${token.slice(2).split("").reverse().join("")}`;
    await expect(redeemToken(home, forged, prepared(), LATER)).rejects.toThrow("does not match any approval");
  });

  it("refuses a token after the item expired", async () => {
    const { home, token } = await approved();
    await expect(redeemToken(home, token, prepared(), NEXT_DAY)).rejects.toThrow("Approval 1 has expired; request a new approval");
  });

  it("refuses a member's approval once the action has become L3", async () => {
    const { home, token } = await approved();
    await expect(redeemToken(home, token, prepared(undefined, "L3"), LATER)).rejects.toThrow("memo.edit is now L3; approval 1 was given by a member");
  });

  it("keeps the audit chain whole through a whole request → decide → redeem round", async () => {
    const { home, token } = await approved("L3", BOSS);
    await redeemToken(home, token, prepared(undefined, "L3"), LATER);
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 2 });
  });
});
