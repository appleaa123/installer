import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_FILE, appendAudit } from "../../src/core/audit.js";
import { readConfig, writeConfig } from "../../src/core/data-source.js";
import { DAILY_CHECK_TIMEOUT_MS, DOCTOR_FILE, DOCTOR_NEXT, dailyDoctor, loadDoctorReport, runDoctor } from "../../src/core/doctor.js";
import { PID_FILE, claimPid } from "../../src/core/gateway-process.js";
import { deleteSecret, setSecret } from "../../src/core/keychain.js";
import { startRun } from "../../src/core/runner.js";
import { KEYS_DIR, RUNS_DIR, recordMissed } from "../../src/core/runs.js";
import { STATE_FILE, loadState, saveState } from "../../src/core/state.js";
import { HEARTBEAT_FILE } from "../../src/core/tick.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { OWNER, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { deadPid } from "../helpers/dead-pid.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OLD = "2026-10-08T11:00:00.000Z";
const PLENTY = async (): Promise<number> => 50 * 1024 ** 3;
const NOTE = parseWorkflow({ workflow: "note", version: 1, steps: [{ id: "add", tool: "memo.add", args: { text: "x" } }] }, "note", DEFAULT_TOOLS);
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const doctor = (home: string, freeBytes = PLENTY) => runDoctor(home, { now: () => AT, freeBytes });
const find = (report: { checks: readonly { id: string }[] }, id: string) => report.checks.find((check) => check.id === id);
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const keyFile = (home: string, key: string): string => join(home, KEYS_DIR, createHash("sha256").update(key).digest("hex"));

async function healthyHome(): Promise<string> {
  const home = await runnerHome();
  await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
  return home;
}

describe("taskpilot doctor (§16.1, D103)", () => {
  it("says ok for a healthy home, keeps the findings and audits the run", async () => {
    const home = await healthyHome();
    const report = await doctor(home);
    expect(report.status).toBe("ok");
    expect(report.checks.map((check) => check.id)).toEqual(["state", "audit", "pause", "secrets", "runner", "gateway", "disk", "host", "run_claims", "run_records", "recent_runs", "retention", "hardening"]);
    expect(await loadDoctorReport(home)).toEqual(report);
    expect(await events(home)).toEqual(["doctor.ran"]);
  });

  it("reports a broken audit chain and a damaged state, naming the backup, instead of stopping", async () => {
    const home = await healthyHome();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, started_at: AT });
    await appendAudit(home, { ts: AT, actor: "engine", event: "one", ref: "x", payload: {} });
    await appendAudit(home, { ts: AT, actor: "engine", event: "two", ref: "x", payload: {} });
    const lines = (await readFile(join(home, AUDIT_FILE), "utf8")).replace('"event":"one"', '"event":"won"');
    await writeFile(join(home, AUDIT_FILE), lines);
    await writeFile(join(home, STATE_FILE), "{ not json");
    const report = await doctor(home);
    expect(report.status).toBe("fail");
    expect(find(report, "state")).toMatchObject({ status: "fail", detail: expect.stringContaining("install-state.json.bak") });
    expect(find(report, "audit")).toMatchObject({ status: "fail", detail: expect.stringContaining("line 1: hash mismatch") });
    expect((await events(home)).filter((event) => event === "doctor.ran")).toEqual([]);
  });

  it("clears a run claim a crash left without its run.json once it is old, and the key works again", async () => {
    const home = await healthyHome();
    await mkdir(join(home, KEYS_DIR), { recursive: true });
    await writeFile(keyFile(home, "note:old"), JSON.stringify({ workflow: "note", run_id: "2026-10-08-0000aaaa" }));
    await utimes(keyFile(home, "note:old"), new Date(OLD), new Date(OLD));
    await writeFile(keyFile(home, "note:fresh"), JSON.stringify({ workflow: "note", run_id: "2026-10-08-0000bbbb" }));
    await utimes(keyFile(home, "note:fresh"), new Date(AT), new Date(AT));
    const report = await doctor(home);
    expect(find(report, "run_claims")).toMatchObject({ status: "fixed", detail: expect.stringContaining("cleared 1 run claim") });
    await expect(access(keyFile(home, "note:old"))).rejects.toThrow();
    await access(keyFile(home, "note:fresh"));
    expect(await events(home)).toContain("run.claim_cleared");
    expect((await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => AT })).status).toBe("completed");
  });

  it("names damaged run records the tick skips, and runs of the last day that failed or were missed", async () => {
    const home = await healthyHome();
    await mkdir(join(home, RUNS_DIR, "note", "bad"), { recursive: true });
    await writeFile(join(home, RUNS_DIR, "note", "bad", "run.json"), "{");
    await recordMissed(home, "note", 1, "note:2026-10-08T11:00:00.000Z", "2026-10-08T11:00:00.000Z", "2026-10-08T11:30:00.000Z");
    const report = await doctor(home);
    expect(report.status).toBe("warn");
    expect(find(report, "run_records")).toMatchObject({ status: "warn", detail: expect.stringContaining("runs/note/bad") });
    expect(find(report, "recent_runs")).toMatchObject({ status: "warn", detail: expect.stringContaining("missed") });
  });

  it("finds missing keychain items, an unusable Skills Wiki and a channel whose secret is gone", async () => {
    const home = await channelHome(true);
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: "http://127.0.0.1:9/mcp" } });
    await writeConfig(home, HEARTBEAT_FILE, { last: AT, alive: AT, pid: 1 });
    expect(find(await doctor(home), "channel.telegram")).toMatchObject({ status: "ok", detail: "@desk_test_bot answers" });
    await deleteSecret("telegram");
    const report = await doctor(home);
    expect(find(report, "secrets")).toMatchObject({ status: "fail", detail: "missing from the keychain: skillswiki, telegram", fix: "taskpilot secret skillswiki; taskpilot secret telegram" });
    expect(find(report, "skillswiki")).toMatchObject({ status: "fail", detail: expect.stringContaining("taskpilot secret skillswiki") });
    expect(find(report, "channel.telegram")).toMatchObject({ status: "fail", detail: expect.stringContaining("taskpilot secret telegram") });
    await setSecret("telegram", BOT_TOKEN);
  });

  it("sees a gateway that died, a runner that stopped ticking and a nearly full disk", async () => {
    const home = await channelHome(true);
    await writeConfig(home, HEARTBEAT_FILE, { last: OLD, alive: OLD, pid: 1 });
    await mkdir(join(home, "runtime", "gateway"), { recursive: true });
    await writeFile(join(home, PID_FILE), JSON.stringify({ pid: deadPid(), started_at: OLD }));
    const report = await doctor(home, async () => 100 * 1024 ** 2);
    expect(find(report, "gateway")).toMatchObject({ status: "fail", fix: expect.stringContaining("taskpilot gateway start") });
    expect(find(report, "runner")).toMatchObject({ status: "warn", detail: "no tick for 60 minutes (last 2026-10-08T11:00:00.000Z)" });
    expect(find(report, "disk")).toMatchObject({ status: "warn", detail: "only 0.1 GiB free on the engine's disk" });
  });

  it("runs once a day from the tick, the first time only setting the time, and tells the decision maker what failed", async () => {
    const home = await channelHome(true);
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: "http://127.0.0.1:9/mcp" } });
    expect(await dailyDoctor(home, () => AT)).toBeNull();
    expect(await dailyDoctor(home, () => "2026-10-08T18:00:00.000Z")).toBeNull();
    expect(await dailyDoctor(home, () => "2026-10-09T12:01:00.000Z")).toMatchObject({ status: "fail" });
    expect((await fake.sent()).filter((message) => message.chat_id === OWNER.address).map((message) => message.text)).toContainEqual(expect.stringContaining("Daily check:"));
    expect(await events(home)).toContain("doctor.notified");
    await access(join(home, DOCTOR_FILE));
  });
});

describe("a check that throws", () => {
  it("becomes a fail finding with its message and no stack, whatever it throws", async () => {
    const home = await healthyHome();
    const plain = { id: "plain", run: async () => Promise.reject(new Error("the disk said no")) };
    const typed = { id: "typed", run: async () => Promise.reject(new TypeError("cannot read properties of undefined")) };
    const report = await runDoctor(home, { now: () => AT, freeBytes: PLENTY }, [plain, typed]);
    expect(report.checks).toEqual([{ id: "plain", status: "fail", detail: "the disk said no" }, { id: "typed", status: "fail", detail: "cannot read properties of undefined" }]);
    expect(JSON.stringify(report)).not.toContain("    at ");
  });

  it("from the tick: the next daily run is set only once this run has finished", async () => {
    const home = await healthyHome();
    await writeConfig(home, DOCTOR_NEXT, { at: OLD });
    const peek = { id: "peek", run: async () => ({ id: "peek", status: "ok" as const, detail: JSON.stringify(await readConfig(home, DOCTOR_NEXT)) }) };
    const report = await dailyDoctor(home, () => AT, undefined, { checks: [peek] });
    expect(report?.checks[0]?.detail).toBe(JSON.stringify({ at: OLD }));
    expect(await readConfig(home, DOCTOR_NEXT)).toEqual({ at: "2026-10-09T12:00:00.000Z" });
  });
});

describe("the daily doctor's time limit", () => {
  it("turns a check from the tick that never finishes into a fail finding, and goes on with the next one", async () => {
    const home = await healthyHome();
    await writeConfig(home, DOCTOR_NEXT, { at: AT });
    const stuck = { id: "stuck", run: () => new Promise<never>(() => undefined) };
    const after = { id: "after", run: async () => ({ id: "after", status: "ok" as const, detail: "ran" }) };
    const report = await dailyDoctor(home, () => AT, undefined, { checks: [stuck, after], timeoutMs: 50 });
    expect(report?.checks).toEqual([{ id: "stuck", status: "fail", detail: "did not finish within 0.05 s" }, { id: "after", status: "ok", detail: "ran" }]);
    expect(DAILY_CHECK_TIMEOUT_MS).toBe(20_000);
  });
});

describe("the gateway's pid file (D103)", () => {
  it("is claimed exclusively: a live gateway's file is never replaced, a dead one's is", async () => {
    const home = await runnerHome();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
    try {
      await mkdir(join(home, "runtime", "gateway"), { recursive: true });
      await writeFile(join(home, PID_FILE), JSON.stringify({ pid: sleeper.pid, started_at: AT }));
      await expect(claimPid(home, AT)).rejects.toThrow(`Another gateway is running for this home (pid ${sleeper.pid})`);
      await writeFile(join(home, PID_FILE), JSON.stringify({ pid: deadPid(), started_at: AT }));
      await claimPid(home, AT);
      expect(JSON.parse(await readFile(join(home, PID_FILE), "utf8"))).toEqual({ pid: process.pid, started_at: AT });
    } finally {
      sleeper.kill("SIGKILL");
    }
  });
});
