import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolRefusal } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { killSwitchIn } from "../../src/core/envelope.js";
import { handleInbound } from "../../src/core/inbound.js";
import { listInbox } from "../../src/core/inbox.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { PAUSED_REASON, isPaused, loadPause, pauseCommand, setPaused, unpauseCommand } from "../../src/core/pause.js";
import { startRun } from "../../src/core/runner.js";
import { listRuns } from "../../src/core/runs.js";
import { HEARTBEAT_FILE, tick } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { ADA, OWNER, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const AGENT = { interactive: false };
const PERSON = { interactive: true, as: "Owner" };
/** Every ten minutes in Toronto, one memo each time. */
const EVERY_TEN = { workflow: "pulse", version: 1, trigger: { cron: "*/10 * * * *", tz: "America/Toronto" }, steps: [{ id: "note", tool: "memo.add", args: { text: "Pulse ${run.scheduled_for}" } }] };
let fake: FakeTelegram;
let ids = 0;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const from = (address: string, text: string) => ({ channel: "telegram", from: address, thread: address, text, message_id: `p${++ids}` });
const sentTo = async (chat: string): Promise<string[]> => (await fake.sent()).filter((message) => message.chat_id === chat).map((message) => message.text);
const ctxOf = async (home: string, via: "cli" | "gateway" = "cli") => toolContext(home, via, DEFAULT_TOOLS, () => AT);

describe("the kill switch (§14.4, D36, D101)", () => {
  it("reads /pause and /unpause only as the whole first line", () => {
    expect(killSwitchIn("/pause")).toBe("pause");
    expect(killSwitchIn("  /UNPAUSE@desk_test_bot\nthanks")).toBe("unpause");
    expect(killSwitchIn("please /pause")).toBeNull();
    expect(killSwitchIn("/pause now")).toBeNull();
  });

  it("is off when nothing set it; pausing and unpausing are audited with who did it", async () => {
    const home = await runnerHome();
    expect(await isPaused(home)).toBe(false);
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT, "checking a report");
    expect(await loadPause(home)).toEqual({ paused: true, at: AT, by: "agent", via: "cli", reason: "checking a report" });
    await setPaused(home, false, { name: "Owner", actor: "human", via: "cli" }, AT);
    expect(await isPaused(home)).toBe(false);
    expect((await events(home)).slice(-2)).toEqual(["engine.paused", "engine.unpaused"]);
  });

  it("records every message while paused and refuses every other action above L0; reads still work", async () => {
    const home = await channelHome(true);
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    const ctx = await ctxOf(home);
    const notified = await invokeTool(ctx, "channel.notify", { member: "Owner", text: "Held back by the pause" });
    expect(notified.deliveries).toEqual([{ channel: "telegram", status: "recorded", outbox_id: 1, reason: PAUSED_REASON }]);
    expect(await sentTo(OWNER.address)).not.toContain("Held back by the pause");
    await expect(invokeTool(ctx, "memo.add", { text: "x" })).rejects.toThrow(ToolRefusal);
    expect(await invokeTool(ctx, "memo.list", {})).toEqual({ memos: [] });
    expect(JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8"))).toMatchObject({ text: "Held back by the pause", reason: PAUSED_REASON });
    expect(await events(home)).toContain("tool.refused");
  });

  it("stops the runner: nothing starts, the tick only notes the host is alive, and slots in the pause are missed afterwards", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, EVERY_TEN);
    await writeConfig(home, HEARTBEAT_FILE, { last: "2026-10-08T11:59:00.000Z", pid: 1 });
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    expect(await tick(home, () => "2026-10-08T12:00:30.000Z")).toMatchObject({ status: "paused", started: [], missed: [] });
    expect(JSON.parse(await readFile(join(home, HEARTBEAT_FILE), "utf8"))).toMatchObject({ last: "2026-10-08T11:59:00.000Z", alive: "2026-10-08T12:00:30.000Z" });
    const workflow = parseWorkflow(EVERY_TEN, "pulse", DEFAULT_TOOLS);
    await expect(startRun({ home, workflow, key: "pulse:manual", trigger: { kind: "manual" }, now: () => AT })).rejects.toThrow("No run starts");
    expect(await tick(home, () => "2026-10-08T12:19:30.000Z")).toMatchObject({ status: "paused" });
    await setPaused(home, false, { name: "Owner", actor: "human", via: "cli" }, AT);
    const after = await tick(home, () => "2026-10-08T12:20:30.000Z");
    expect(after).toMatchObject({ status: "ran", back_online: false, missed: [expect.stringContaining("(missed)"), expect.stringContaining("(missed)")], started: [expect.stringContaining("(completed)")] });
    expect((await listRuns(home, "pulse")).map((run) => run.status)).toEqual(["missed", "missed", "completed"]);
  });

  it("works from the decision maker's Telegram: /pause answers before it stops, /unpause after it restarts", async () => {
    const home = await channelHome(true);
    const gateway = await ctxOf(home, "gateway");
    expect(await handleInbound(gateway, from(OWNER.address, "/pause"))).toBe("decided");
    expect(await loadPause(home)).toMatchObject({ paused: true, by: "Owner", via: "telegram" });
    expect(await sentTo(OWNER.address)).toContainEqual(expect.stringContaining("Paused."));
    expect(await handleInbound(gateway, from(OWNER.address, "/unpause"))).toBe("decided");
    expect(await isPaused(home)).toBe(false);
    expect(await sentTo(OWNER.address)).toContainEqual(expect.stringContaining("Running again"));
    expect((await listInbox(home)).map((item) => item.route)).toEqual(["command", "command"]);
  });

  it("refuses a member's /pause and audits it; a stranger's /pause is only a message", async () => {
    const home = await channelHome(true);
    const gateway = await ctxOf(home, "gateway");
    expect(await handleInbound(gateway, from(ADA.address, "/pause"))).toBe("refused");
    expect(await handleInbound(gateway, from("5005", "/pause"))).toBe("event");
    expect(await isPaused(home)).toBe(false);
    expect(await events(home)).toContain("engine.switch_refused");
    expect(await sentTo(ADA.address)).toContainEqual(expect.stringContaining("Only the decision maker"));
  });

  it("lets anyone pause from the CLI, but unpausing needs a person's terminal; the agent's attempt is refused and audited", async () => {
    const home = await runnerHome();
    expect(await pauseCommand(home, undefined, AGENT, "a test", () => AT)).toMatchObject({ status: "paused", by: "agent", reason: "a test" });
    await expect(unpauseCommand(home, AGENT, () => AT)).rejects.toThrow("in their own terminal");
    expect(await isPaused(home)).toBe(true);
    expect(await events(home)).toContain("engine.unpause_refused");
    expect(await unpauseCommand(home, PERSON, () => AT)).toMatchObject({ status: "unpaused", paused: false, by: "Owner" });
    expect(await pauseCommand(home, "status", AGENT, undefined, () => AT)).toEqual({ pause: { paused: false, at: AT, by: "Owner", via: "cli" } });
  });
});
