import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const MEMBER = { name: "terminal", role: "member" } as const;

async function installed(): Promise<string> {
  const home = await makeTempHome();
  expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
  return home;
}

/** Async CLI run, so two can race. */
function runAsync(args: readonly string[], home: string): Promise<number | null> {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "--home", home, ...args], { stdio: "ignore" });
  return new Promise((done) => child.once("exit", done));
}

async function lastEvent(home: string): Promise<string> {
  const last = (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").at(-1) ?? "{}";
  return (JSON.parse(last) as { event: string }).event;
}

describe("installer tool (C6 fallback, §7.4)", () => {
  it("runs an L1 tool and prints its result", async () => {
    const home = await installed();
    const result = runCli(["tool", "memo.add", '{"text":"Ship the order on Monday"}'], { home });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ id: 1, text: "Ship the order on Monday" });
    expect(runCli(["tool", "memo.list"], { home }).json).toMatchObject({ memos: [{ id: 1 }] });
  });

  it("refuses an L2 tool without a token with exit 2 and the way to ask", async () => {
    const home = await installed();
    runCli(["tool", "memo.add", '{"text":"a"}'], { home });
    const result = runCli(["tool", "memo.edit", '{"id":1,"text":"b"}'], { home });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: expect.stringContaining("memo.edit is L2 (no declared level (default L2)): a person must approve it first. Call approvals.request"), code: 2 });
    expect(await lastEvent(home)).toBe("tool.refused");
  });

  it("runs the whole round: request, a person approves, the agent fetches the token and runs it once", async () => {
    const home = await installed();
    runCli(["tool", "memo.add", '{"text":"a"}'], { home });
    const asked = runCli(["tool", "approvals.request", '{"tool":"memo.edit","args":{"id":1,"text":"b"},"why":"The note is out of date."}'], { home });
    expect(asked.json).toMatchObject({ id: 1, status: "pending", level: "L2", next: expect.stringContaining("installer approvals approve 1") });
    const refused = runCli(["approvals", "approve", "1"], { home });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("Approvals are decided by a person in their own terminal") });
    await approveItem(home, 1, MEMBER, new Date().toISOString());
    const token = (runCli(["tool", "approvals.get", '{"id":1}'], { home }).json as { approval_token: string }).approval_token;
    expect(runCli(["approvals", "list"], { home }).stdout).not.toContain(token);
    const call = JSON.stringify({ id: 1, text: "b", approval_token: token });
    expect(runCli(["tool", "memo.edit", call], { home })).toMatchObject({ code: 0, json: { id: 1, text: "b" } });
    expect(runCli(["tool", "memo.edit", call], { home })).toMatchObject({ code: 2, json: { error: "Approval 1 was already used; request a new approval" } });
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: true });
  });

  it("lets only one of two simultaneous calls with the same token run (Review Focus 1)", async () => {
    const home = await installed();
    runCli(["tool", "memo.add", '{"text":"a"}'], { home });
    runCli(["tool", "approvals.request", '{"tool":"memo.edit","args":{"id":1,"text":"b"},"why":"x"}'], { home });
    await approveItem(home, 1, MEMBER, new Date().toISOString());
    const token = (runCli(["tool", "approvals.get", '{"id":1}'], { home }).json as { approval_token: string }).approval_token;
    const call = JSON.stringify({ id: 1, text: "b", approval_token: token });
    const codes = await Promise.all([runAsync(["tool", "memo.edit", call], home), runAsync(["tool", "memo.edit", call], home)]);
    expect(codes.sort()).toEqual([0, 2]);
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: true });
  });

  it.each([
    [["tool"], "tool needs a tool name"],
    [["tool", "memo.nothing", "{}"], "Unknown tool 'memo.nothing'"],
    [["tool", "memo.add", "not json"], "The arguments of 'memo.add' must be JSON"],
    [["tool", "memo.add", "[]"], "Tool arguments must be a JSON object"],
    [["approvals", "close", "1"], "approvals needs one of"],
  ])("refuses %j with exit 2", async (args, message) => {
    const home = await installed();
    const result = runCli(args, { home });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: expect.stringContaining(message), code: 2 });
  });

  it.each([[["tool", "memo.list"]], [["approvals", "list"]]])("%j without an install fails clearly and creates nothing", async (args) => {
    const home = await makeTempHome();
    const result = runCli(args, { home });
    expect(result.code).toBe(2);
    expect(result.json).toMatchObject({ error: "No install found in this home; run 'installer start --solution <ref>' first" });
  });
});
