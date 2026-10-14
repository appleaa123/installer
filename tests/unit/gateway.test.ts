import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCursor } from "../../src/core/channels.js";
import { LOG_FILE, receiveRound, runGateway, statusFile } from "../../src/core/gateway.js";
import { listInbox } from "../../src/core/inbox.js";
import { createInvite, memberFor } from "../../src/core/members.js";
import { ROLES, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { makeTempHome } from "../helpers/temp-home.js";

let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

async function until(check: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

const logLines = async (home: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(home, LOG_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the gateway loop (D72)", () => {
  it("reads one round, hands each message to the pipeline and moves the cursor past it", async () => {
    const home = await channelHome(true);
    await fake.message(9100, "first");
    const options = { home, signal: new AbortController().signal, pollSeconds: 0, pauseMs: 10 };
    expect(await receiveRound(options, "telegram")).toBeGreaterThan(0);
    const cursor = await loadCursor(home, "telegram");
    expect(cursor?.offset).toBeGreaterThan(0);
    expect(await receiveRound(options, "telegram")).toBe(0);
    expect((await listInbox(home)).some((item) => item.from === "9100" && item.route === "event")).toBe(true);
  });

  it("runs until stopped: a person joins while it runs, and it writes a heartbeat and a log without message text", async () => {
    const home = await channelHome(true);
    const { code } = await createInvite(home, "Grace", ROLES, new Date().toISOString());
    const stop = new AbortController();
    const running = runGateway({ home, signal: stop.signal, pollSeconds: 1, pauseMs: 100 });
    await fake.message(9200, `/join ${code}`);
    await until(async () => (await memberFor(home, { channel: "telegram", address: "9200" }, new Date().toISOString())) !== null);
    stop.abort();
    await running;
    expect(JSON.parse(await readFile(join(home, statusFile("telegram")), "utf8"))).toMatchObject({ pid: process.pid });
    const log = await logLines(home);
    expect(log[0]).toMatchObject({ level: "info", event: "started", channels: ["telegram"] });
    expect(log.at(-1)).toMatchObject({ event: "stopped" });
    expect(JSON.stringify(log)).not.toContain(code);
  });

  it("logs a failing round and keeps trying until stopped", async () => {
    const home = await channelHome(true);
    const stop = new AbortController();
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const running = runGateway({ home, signal: stop.signal, pollSeconds: 1, pauseMs: 100, env });
    await until(async () => (await logLines(home).catch(() => [])).filter((line) => line.level === "error").length >= 2);
    stop.abort();
    await running;
    expect((await logLines(home)).find((line) => line.level === "error")).toMatchObject({ loop: "telegram", error: "No telegram secret is stored: run 'taskfollow secret telegram' and enter it on the page that opens" });
  });
});
