import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { listApprovals } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { OUTBOX_DIR, outboundBlock } from "../../src/core/outbound.js";
import { startRun } from "../../src/core/runner.js";
import { loadSandboxMode, runsInSandbox, sandboxMode, saveWorkflowState, setSandboxMode } from "../../src/core/sandbox.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

const flow = (steps: unknown[]) => parseWorkflow({ workflow: "trial", version: 1, steps }, "trial", DEFAULT_TOOLS);
const run = (home: string, steps: unknown[], sandbox = true) => startRun({ home, workflow: flow(steps), key: `trial:${Math.random()}`, trigger: { kind: "manual" }, now: () => AT, sandbox });
const outbox = async (home: string, id: number) => JSON.parse(await readFile(join(home, OUTBOX_DIR, `${id}.json`), "utf8")) as Record<string, unknown>;
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("sandbox mode (§15.5, D91)", () => {
  it("is off when nothing set it, and is switched on and off with an audit line each time", async () => {
    const home = await runnerHome();
    expect(await sandboxMode(home)).toBe(false);
    await setSandboxMode(home, true, "engine", AT);
    expect(await loadSandboxMode(home)).toEqual({ on: true, at: AT, by: "engine" });
    await setSandboxMode(home, false, "Owner", AT);
    expect(await sandboxMode(home)).toBe(false);
    expect((await events(home)).slice(-2)).toEqual(["sandbox.on", "sandbox.off"]);
  });

  it("records every message of a finished install while it is on, and says so", async () => {
    const home = await channelHome(true);
    expect(await outboundBlock(home)).toBeNull();
    await setSandboxMode(home, true, "engine", AT);
    expect(await outboundBlock(home)).toContain("sandbox mode");
    const result = await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "channel.notify", { member: "Owner", text: "Hello from sandbox mode" });
    expect(result.deliveries).toEqual([{ channel: "telegram", status: "recorded", outbox_id: 1, reason: expect.stringContaining("sandbox mode") }]);
    expect((await fake.sent()).map((message) => message.text)).not.toContain("Hello from sandbox mode");
  });

  it("makes every run a sandbox run, and so does a workflow that is not confirmed yet", async () => {
    const home = await runnerHome();
    expect(await runsInSandbox(home, "trial")).toBe(false);
    await saveWorkflowState(home, { workflow: "trial", sandbox: true });
    expect(await runsInSandbox(home, "trial")).toBe(true);
    expect(await run(home, [{ id: "add", tool: "memo.add", args: { text: "x" } }], false)).toMatchObject({ sandbox: true, status: "completed" });
    await saveWorkflowState(home, { workflow: "trial", sandbox: false });
    await setSandboxMode(home, true, "engine", AT);
    expect(await run(home, [{ id: "add", tool: "memo.add", args: { text: "y" } }], false)).toMatchObject({ sandbox: true });
    expect(await memos(home)).toEqual([]);
  });

  it("does not change what the agent's own calls do: an agent's memo.add still runs", async () => {
    const home = await runnerHome();
    await setSandboxMode(home, true, "engine", AT);
    await invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS, () => AT), "memo.add", { text: "kept" });
    expect(await memos(home)).toEqual(["kept"]);
  });
});

describe("a sandbox run (D91)", () => {
  it("reads for real but records a write instead of making it", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "One" });
    const record = await run(home, [{ id: "read", tool: "memo.list" }, { id: "add", tool: "memo.add", args: { text: "First: ${read.memos[0].text}" } }]);
    expect(record).toMatchObject({ status: "completed", sandbox: true, actions: 1 });
    expect(await memos(home)).toEqual(["One"]);
    expect(await outbox(home, 1)).toMatchObject({ action: { tool: "memo.add", args: { text: "First: One" } }, level: "L1", run: `trial/${record.run_id}`, reason: expect.stringContaining("never run") });
    expect(await events(home)).toContain("action.recorded");
  });

  it("asks no approval for an L2 or L3 call: it records the call and continues", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "One" });
    const record = await run(home, [
      { id: "edit", tool: "memo.edit", args: { id: 1, text: "Two" } },
      { id: "drop", approve: { tool: "memo.delete", args: { id: 1 }, why: "Tidy up" } },
    ]);
    expect(record).toMatchObject({ status: "completed", actions: 2 });
    expect(await listApprovals(home, AT)).toEqual([]);
    expect(await outbox(home, 1)).toMatchObject({ action: { tool: "memo.edit" }, level: "L2" });
    expect(await outbox(home, 2)).toMatchObject({ action: { tool: "memo.delete", args: { id: 1 } }, level: "L3" });
    expect(await memos(home)).toEqual(["One"]);
  });

  it("records an external message as a message, with its run, and sends nothing (consent still applies)", async () => {
    const home = await channelHome(true);
    const refused = await run(home, [{ id: "send", tool: "channel.send", args: { channel: "telegram", to: "5005", text: "Sandbox only" } }]);
    expect(refused).toMatchObject({ status: "failed", reason: expect.stringContaining("must write first") });
    expect(await outbox(home, 1)).toMatchObject({ to: "1002", text: expect.stringContaining("failed"), run: `trial/${refused.run_id}` });
    await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text: "Hello", message_id: "m1" }, AT), "event");
    const record = await run(home, [{ id: "send", tool: "channel.send", args: { channel: "telegram", to: "5005", text: "Sandbox only" } }]);
    expect(record).toMatchObject({ status: "completed", sandbox: true });
    expect(await outbox(home, 2)).toMatchObject({ channel: "telegram", to: "5005", text: "Sandbox only", run: `trial/${record.run_id}` });
    expect((await fake.sent()).map((message) => message.text)).not.toContain("Sandbox only");
    expect(await listApprovals(home, AT)).toEqual([]);
  });
});
