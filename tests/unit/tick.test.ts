import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { writeConfig } from "../../src/core/data-source.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { RUNS_DIR, listRuns } from "../../src/core/runs.js";
import { EVENTS_CURSOR, HEARTBEAT_FILE, TICK_LOCK, tick } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { deadPid } from "../helpers/dead-pid.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** Weekdays 08:00 in Toronto (12:00 UTC in October), one memo each time. */
const MORNING = { workflow: "morning", version: 1, trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, steps: [{ id: "note", tool: "memo.add", args: { text: "Morning ${run.scheduled_for}" } }] };
const INTAKE = { workflow: "intake", version: 1, trigger: { event: "message.received", from: "external" }, steps: [{ id: "keep", tool: "memo.add", args: { text: "${event.channel} ${event.from}: ${event.text}" } }] };
const TEAM = { workflow: "team", version: 1, trigger: { event: "message.received", from: "member", channel: "telegram" }, steps: [{ id: "keep", tool: "memo.add", args: { text: "member said ${event.text}" } }] };
const THU_0800 = "2026-10-08T12:00:00.000Z";
const clock = (iso: string) => () => iso;
/** A tick that starts at `start` and whose later reads of the clock (its runs, its end) see `end`. */
const slowClock = (start: string, end: string) => {
  let first = true;
  return () => (first ? ((first = false), start) : end);
};
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const heartbeat = (home: string, last: string) => writeConfig(home, HEARTBEAT_FILE, { last, pid: 1 });
const audited = async (home: string, event: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).split("\n").filter((line) => line.includes(`"event":"${event}"`)).length;

async function morningHome(): Promise<string> {
  const home = await runnerHome();
  await writeWorkflow(home, MORNING);
  return home;
}

describe("scheduled runs (§10.3, D82)", () => {
  it("starts the run that is due, once, and writes the heartbeat", async () => {
    const home = await morningHome();
    const first = await tick(home, clock("2026-10-08T12:00:20.000Z"));
    expect(first).toMatchObject({ status: "ran", started: [expect.stringMatching(/^morning 2026-10-08-[0-9a-f]{8} \(completed\)$/)], missed: [], back_online: false });
    expect(await tick(home, clock("2026-10-08T12:01:05.000Z"))).toMatchObject({ started: [], missed: [] });
    expect(await memos(home)).toEqual([`Morning ${THU_0800}`]);
    expect(JSON.parse(await readFile(join(home, HEARTBEAT_FILE), "utf8"))).toMatchObject({ last: "2026-10-08T12:01:05.000Z" });
  });

  it("still runs a slot that is late within its tolerance", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T11:59:10.000Z");
    expect((await tick(home, clock("2026-10-08T12:04:30.000Z"))).started).toHaveLength(1);
  });

  it("never runs a slot late: past the tolerance it is recorded as missed (D38)", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T11:58:00.000Z");
    const result = await tick(home, clock("2026-10-08T12:05:30.000Z"));
    expect(result).toMatchObject({ started: [], missed: [expect.stringMatching(/^morning .* \(missed\)$/)] });
    expect(await memos(home)).toEqual([]);
    expect((await tick(home, clock("2026-10-08T12:06:30.000Z"))).missed).toEqual([]);
  });

  it("does not count a slot from before the first tick as missed", async () => {
    const home = await morningHome();
    expect(await tick(home, clock("2026-10-08T15:00:00.000Z"))).toMatchObject({ started: [], missed: [], back_online: false });
  });

  it("does nothing while another tick holds the lock, and takes over a dead tick's lock", async () => {
    const home = await morningHome();
    await mkdir(join(home, "runtime", "runner"), { recursive: true });
    await writeFile(join(home, TICK_LOCK), String(process.pid));
    expect(await tick(home, clock("2026-10-08T12:00:20.000Z"))).toMatchObject({ status: "busy", started: [] });
    await writeFile(join(home, TICK_LOCK), String(deadPid()));
    expect((await tick(home, clock("2026-10-08T12:00:20.000Z"))).started).toHaveLength(1);
  });

  it("reports a broken workflow file and still runs the others", async () => {
    const home = await morningHome();
    await writeWorkflow(home, { ...MORNING, workflow: "broken", steps: [{ id: "x", tool: "memo.nothing" }] });
    expect(await tick(home, clock("2026-10-08T12:00:20.000Z"))).toMatchObject({ started: [expect.stringMatching(/^morning /)], errors: [expect.stringContaining("Workflow 'broken'")] });
  });
});

describe("host back online (D38, D84)", () => {
  it("records every missed run of a long downtime and sends one notice listing them", async () => {
    const home = await channelHome(false);
    await writeWorkflow(home, MORNING);
    await heartbeat(home, "2026-10-07T20:00:00.000Z");
    const result = await tick(home, clock("2026-10-12T12:30:00.000Z"));
    expect(result.missed).toHaveLength(3);
    expect(result).toMatchObject({ started: [], back_online: true });
    const notice = JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8")) as { to: string; text: string };
    expect(notice.to).toBe("1002");
    expect(notice.text).toContain("The host is back online. The runner did not run from 2026-10-07T20:00:00.000Z to 2026-10-12T12:30:00.000Z");
    expect(notice.text).toContain("Missed runs, not run: morning ");
    expect(await audited(home, "runner.back_online")).toBe(1);
    expect((await listRuns(home, "morning")).map((run) => run.status)).toEqual(["missed", "missed", "missed"]);
  });

  it("says so in the audit when there is nobody to tell", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T10:00:00.000Z");
    expect(await tick(home, clock("2026-10-08T14:00:00.000Z"))).toMatchObject({ back_online: true, missed: [expect.any(String)] });
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"runner.back_online"');
  });

  it("does not take a slow tick for downtime: the heartbeat marks its end too", async () => {
    const home = await runnerHome();
    await heartbeat(home, "2026-10-08T11:59:00.000Z");
    expect(await tick(home, slowClock("2026-10-08T12:00:00.000Z", "2026-10-08T12:07:00.000Z"))).toMatchObject({ back_online: false });
    expect(JSON.parse(await readFile(join(home, HEARTBEAT_FILE), "utf8"))).toMatchObject({ last: "2026-10-08T12:00:00.000Z", alive: "2026-10-08T12:07:00.000Z" });
    expect(await tick(home, clock("2026-10-08T12:08:00.000Z"))).toMatchObject({ back_online: false, missed: [] });
  });

  it("does not count a tick that finds another one running as downtime", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T10:00:00.000Z");
    await mkdir(join(home, "runtime", "runner"), { recursive: true });
    await writeFile(join(home, TICK_LOCK), String(process.pid));
    expect(await tick(home, clock("2026-10-08T14:00:00.000Z"))).toMatchObject({ status: "busy", back_online: false, missed: [] });
    expect(await listRuns(home)).toEqual([]);
  });

  it("still records a slot that fell due during a slow tick as missed, without a notice (D38)", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T11:57:00.000Z");
    await tick(home, slowClock("2026-10-08T11:58:00.000Z", "2026-10-08T12:10:00.000Z"));
    expect(await tick(home, clock("2026-10-08T12:11:00.000Z"))).toMatchObject({ back_online: false, missed: [expect.stringMatching(/^morning .* \(missed\)$/)] });
  });

  it("sends the notice once per gap even when a later part of the tick keeps failing", async () => {
    const home = await morningHome();
    await heartbeat(home, "2026-10-08T10:00:00.000Z");
    await mkdir(join(home, "state", "runner"), { recursive: true });
    await writeFile(join(home, EVENTS_CURSOR), "{not json");
    await expect(tick(home, clock("2026-10-08T14:00:00.000Z"))).rejects.toThrow("not valid JSON");
    await expect(tick(home, clock("2026-10-08T14:01:00.000Z"))).rejects.toThrow("not valid JSON");
    expect(await audited(home, "runner.back_online")).toBe(1);
  });
});

describe("event triggers (§10.3, D88)", () => {
  const message = (home: string, from: string, id: string, text: string, route: "event" | "conversation") =>
    storeInbound(home, normalizeInbound({ channel: "telegram", from, thread: from, text, message_id: id }, THU_0800), route);

  it("starts the matching workflow for each new message, never for the old ones", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, INTAKE);
    await writeWorkflow(home, TEAM);
    await message(home, "4001", "old", "Before the runner existed", "event");
    expect(await tick(home, clock(THU_0800))).toMatchObject({ events: 0 });
    await message(home, "4002", "m1", "Is Tuesday free?", "event");
    await message(home, "1001", "m2", "I will take it", "conversation");
    expect(await tick(home, clock("2026-10-08T12:01:00.000Z"))).toMatchObject({ events: 2 });
    expect(await memos(home)).toEqual(["telegram 4002: Is Tuesday free?", "member said I will take it"]);
    expect(await tick(home, clock("2026-10-08T12:02:00.000Z"))).toMatchObject({ events: 0 });
  });
});

describe("resumption (§10.7)", () => {
  it("continues a run once its approval is decided", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.add", { text: "Draft" });
    await writeWorkflow(home, { ...MORNING, steps: [{ id: "fix", approve: { tool: "memo.edit", args: { id: 1, text: "Final" }, why: "The morning check" } }] });
    expect((await tick(home, clock("2026-10-08T12:00:20.000Z"))).started).toEqual([expect.stringContaining("(waiting)")]);
    expect((await tick(home, clock("2026-10-08T12:01:20.000Z"))).resumed).toEqual([]);
    await approveItem(home, 1, { name: "Owner", role: "decision_maker" }, "2026-10-08T12:01:30.000Z");
    expect((await tick(home, clock("2026-10-08T12:02:20.000Z"))).resumed).toEqual([expect.stringContaining("(completed)")]);
    expect(await memos(home)).toEqual(["Final"]);
  });

  it("skips a damaged run record, says so, and still resumes the others", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.add", { text: "Draft" });
    await writeWorkflow(home, { ...MORNING, steps: [{ id: "fix", approve: { tool: "memo.edit", args: { id: 1, text: "Final" }, why: "The morning check" } }] });
    expect((await tick(home, clock("2026-10-08T12:00:20.000Z"))).started).toEqual([expect.stringContaining("(waiting)")]);
    await mkdir(join(home, RUNS_DIR, "morning", "damaged"), { recursive: true });
    await writeFile(join(home, RUNS_DIR, "morning", "damaged", "run.json"), "{}");
    await approveItem(home, 1, { name: "Owner", role: "decision_maker" }, "2026-10-08T12:01:30.000Z");
    const result = await tick(home, clock("2026-10-08T12:02:20.000Z"));
    expect(result.resumed).toEqual([expect.stringContaining("(completed)")]);
    expect(result.errors).toEqual([expect.stringContaining("runs/morning/damaged/run.json")]);
    expect(await audited(home, "run.damaged")).toBe(1);
    expect(await memos(home)).toEqual(["Final"]);
  });
});

describe("the weekly re-check from the tick (D174)", () => {
  const due = async (home: string): Promise<void> => {
    const { recordResult } = await import("../../src/core/checks.js");
    const { RECHECK_FILE } = await import("../../src/core/recheck.js");
    await recordResult(home, { need: "runner", result: "yes-tested", reason: "a pass", at: "2026-10-01T12:00:00.000Z", agent: "fake-agent", agent_version: "9.9.9", test: "t7" });
    await writeConfig(home, RECHECK_FILE, { next: "2026-10-08T00:00:00.000Z" });
  };

  // The suite's switch (vitest.config.ts) is cleared only here, where the starter is a fake that runs nothing.
  beforeEach(() => vi.stubEnv("INSTALLER_RECHECK_AUTOSTART", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("the tick starts the weekly re-check when it is due", async () => {
    const home = await runnerHome();
    await due(home);
    const started: string[] = [];
    const result = await tick(home, clock(THU_0800), {}, undefined, async (startedHome) => void started.push(startedHome));
    expect(started).toEqual([home]);
    expect(result.recheck).toBe("started");
  });

  it("does not start it when the environment switch says none", async () => {
    const home = await runnerHome();
    await due(home);
    const started: string[] = [];
    const result = await tick(home, clock(THU_0800), { INSTALLER_RECHECK_AUTOSTART: "none" }, undefined, async (startedHome) => void started.push(startedHome));
    expect(started).toEqual([]);
    expect(result.recheck).toBeNull();
  });

  it("a paused install starts no re-check", async () => {
    const home = await runnerHome();
    await due(home);
    const { setPaused } = await import("../../src/core/pause.js");
    await setPaused(home, true, { name: "Owner", actor: "human", via: "terminal" }, THU_0800);
    const started: string[] = [];
    await tick(home, clock(THU_0800), {}, undefined, async (startedHome) => void started.push(startedHome));
    expect(started).toEqual([]);
  });

  it("a re-check that cannot start is a tick error, not a crash", async () => {
    const home = await runnerHome();
    await due(home);
    const { ActionFailure } = await import("../../src/core/failure.js");
    const result = await tick(home, clock(THU_0800), {}, undefined, async () => { throw new ActionFailure("The weekly check could not start (exit 3)"); });
    expect(result.errors).toContainEqual(expect.stringContaining("recheck: The weekly check could not start"));
  });
});
