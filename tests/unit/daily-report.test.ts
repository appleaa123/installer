import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { InputError } from "../../src/core/inputs.js";
import { REPORT_CONFIG, composeReport, parseReportConfig, reportSlots, saveReportConfig } from "../../src/core/daily-report.js";
import { REPORT_RUNS, RUNS_DIR, claimRun, listRuns, recordMissed, runIdFor, type RunRecord } from "../../src/core/runs.js";
import { HEARTBEAT_FILE, tick } from "../../src/core/tick.js";
import { writeConfig } from "../../src/core/data-source.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { makeTempHome } from "../helpers/temp-home.js";

const OWNER = { member: "Owner", tz: "America/Toronto" };
/** 09:00 and 17:00 in Toronto in October are 13:00 and 21:00 UTC. */
const NINE = "2026-10-08T13:00:00.000Z";
const FIVE_PREVIOUS = "2026-10-07T21:00:00.000Z";
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const run = (workflow: string, key: string, extra: Partial<RunRecord>): RunRecord => ({
  workflow, run_id: runIdFor(key, extra.trigger?.scheduled_for ?? extra.started_at ?? NINE), key, trigger: { kind: "cron" }, version: 1, status: "completed", started_at: NINE, sandbox: false, pid: 1, actions: 0, needs_human: 0, ...extra,
});
const reportsTo = async (chat: string) => (await fake.sent()).filter((message) => message.chat_id === chat).map((message) => message.text);

describe("the report's settings (D40, D89)", () => {
  it("defaults to 09:00 and 17:00 and keeps each recipient's zone and channels", () => {
    expect(parseReportConfig({ recipients: [{ ...OWNER, channel: "telegram", fallback_channel: "email" }] })).toEqual({
      recipients: [{ member: "Owner", tz: "America/Toronto", channel: "telegram", fallback_channel: "email" }], times: ["09:00", "17:00"],
    });
  });

  it.each([
    [{}, "report needs"],
    [{ recipients: [{ member: "Owner", tz: "Mars/Base" }] }, "tz must be an IANA time zone"],
    [{ recipients: [{ member: "", tz: "UTC" }] }, "needs 'member'"],
    [{ recipients: [{ ...OWNER, channel: "fax" }] }, "channel must be one of telegram, email"],
    [{ recipients: [OWNER], times: ["9am"] }, "times must list HH:MM times"],
  ])("refuses %j", (value, message) => {
    expect(() => parseReportConfig(value)).toThrow(InputError);
    expect(() => parseReportConfig(value)).toThrow(message);
  });

  it("saves the settings and audits them", async () => {
    const home = await makeTempHome();
    expect(await saveReportConfig(home, JSON.stringify({ recipients: [OWNER] }), NINE)).toMatchObject({ status: "saved", report: { times: ["09:00", "17:00"] } });
    expect(JSON.parse(await readFile(join(home, REPORT_CONFIG), "utf8"))).toMatchObject({ recipients: [OWNER] });
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"report.configured"');
    expect(await saveReportConfig(home, undefined, NINE)).toMatchObject({ report: { recipients: [OWNER] } });
  });

  it("finds the slots in each recipient's own zone", () => {
    const config = parseReportConfig({ recipients: [OWNER, { member: "Ada", tz: "Europe/Paris" }] });
    expect(reportSlots(config, OWNER, "2026-10-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).toEqual([NINE, "2026-10-08T21:00:00.000Z"]);
    expect(reportSlots(config, { member: "Ada", tz: "Europe/Paris" }, "2026-10-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).toEqual(["2026-10-08T07:00:00.000Z", "2026-10-08T15:00:00.000Z"]);
  });
});

describe("what the report says (§10.3)", () => {
  it("lists every run in the window, with status, time, actions and the approval it waits for", async () => {
    const home = await makeTempHome();
    await claimRun(home, run("morning", "k1", { trigger: { kind: "cron", scheduled_for: "2026-10-08T12:00:00.000Z" }, started_at: "2026-10-08T12:00:02.000Z", finished_at: "2026-10-08T12:02:12.000Z", actions: 2 }));
    await claimRun(home, run("check", "k2", { status: "waiting", waiting_on: 41, trigger: { kind: "cron", scheduled_for: "2026-10-08T12:30:00.000Z" }, started_at: "2026-10-08T12:30:00.000Z" }));
    await recordMissed(home, "morning", 1, "k3", "2026-10-07T22:00:00.000Z", "2026-10-08T12:00:00.000Z");
    await claimRun(home, run("morning", "k4", { trigger: { kind: "cron", scheduled_for: "2026-10-07T12:00:00.000Z" } }));
    await claimRun(home, run(REPORT_RUNS, "k5", { trigger: { kind: "report", scheduled_for: "2026-10-08T12:59:00.000Z" } }));
    const text = await composeReport(home, OWNER, FIVE_PREVIOUS, NINE);
    expect(text.split("\n")).toEqual([
      "Report Wed 17:00 → Thu 09:00 (America/Toronto): 3 runs.",
      "⏭ morning · Wed 18:00 · skipped (missed)", `   run: ${runIdFor("k3", "2026-10-07T22:00:00.000Z")}`,
      "✅ morning · Thu 08:00 · completed in 2m 10s · 2 actions", `   run: ${runIdFor("k1", "2026-10-08T12:00:00.000Z")}`,
      "⏸ check · Thu 08:30 · waiting · awaiting approval #41", `   run: ${runIdFor("k2", "2026-10-08T12:30:00.000Z")}`,
    ]);
  });

  it("says when there were no runs", async () => {
    expect(await composeReport(await makeTempHome(), OWNER, FIVE_PREVIOUS, NINE)).toBe("Report Wed 17:00 → Thu 09:00 (America/Toronto): 0 runs.\nNo runs in this window.");
  });
});

describe("sending it (D40)", () => {
  it("sends the 09:00 report once, through channel.notify", async () => {
    const home = await channelHome(true);
    await saveReportConfig(home, JSON.stringify({ recipients: [OWNER] }), NINE);
    const result = await tick(home, () => "2026-10-08T13:00:40.000Z");
    expect(result.started).toEqual([expect.stringMatching(/^_report .* \(completed\)$/)]);
    expect(await reportsTo("1002")).toContain("Report Wed 17:00 → Thu 09:00 (America/Toronto): 0 runs.\nNo runs in this window.");
    await tick(home, () => "2026-10-08T13:01:40.000Z");
    expect((await reportsTo("1002")).filter((text) => text.startsWith("Report Wed 17:00"))).toHaveLength(1);
  });

  it("skips a damaged run record, says so, and still sends the report", async () => {
    const home = await channelHome(true);
    await saveReportConfig(home, JSON.stringify({ recipients: [OWNER] }), NINE);
    await mkdir(join(home, RUNS_DIR, "morning", "damaged"), { recursive: true });
    await writeFile(join(home, RUNS_DIR, "morning", "damaged", "run.json"), "{}");
    const result = await tick(home, () => "2026-10-08T13:00:40.000Z");
    expect(result.started).toEqual([expect.stringMatching(/^_report .* \(completed\)$/)]);
    expect(result.errors).toContainEqual(expect.stringMatching(/^report: .*runs\/morning\/damaged\/run\.json/));
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"run.damaged"');
  });

  it("does not send a report late: past five minutes it is missed", async () => {
    const home = await channelHome(true);
    await saveReportConfig(home, JSON.stringify({ recipients: [{ ...OWNER, tz: "Asia/Tokyo" }] }), NINE);
    await writeConfig(home, HEARTBEAT_FILE, { last: "2026-10-08T23:58:00.000Z", pid: 1 });
    const result = await tick(home, () => "2026-10-09T00:06:00.000Z");
    expect(result.missed).toEqual([expect.stringMatching(/^_report .* \(missed\)$/)]);
    expect((await listRuns(home, REPORT_RUNS)).map((record) => record.status)).toEqual(["missed"]);
  });

  it("uses the fallback channel when the recipient's channel fails, and keeps why", async () => {
    const home = await channelHome(true);
    await saveReportConfig(home, JSON.stringify({ recipients: [{ ...OWNER, channel: "email", fallback_channel: "telegram" }] }), NINE);
    await tick(home, () => "2026-10-08T13:00:40.000Z");
    const [report] = await listRuns(home, REPORT_RUNS);
    expect(report).toMatchObject({ status: "completed", reason: expect.stringContaining("sent on the fallback channel telegram; the email channel failed") });
  });
});
