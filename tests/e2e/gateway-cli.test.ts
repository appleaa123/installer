import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOG_FILE } from "../../src/core/gateway.js";
import { setSecret } from "../../src/core/keychain.js";
import { createInvite, memberFor } from "../../src/core/members.js";
import { runCli } from "../helpers/cli.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { waitForExit } from "../helpers/http.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

let telegram: FakeTelegram;
beforeAll(async () => {
  telegram = await startFakeTelegram();
});
afterAll(() => telegram.stop());

/** An install whose Telegram channel is verified; the gateway the CLI starts inherits this env. */
async function install() {
  const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome(), ...telegram.env };
  await setSecret("telegram", BOT_TOKEN, env);
  const home = await makeTempHome();
  runCli(["start", "--solution", FIXTURE_REF], { home, env });
  expect(runCli(["channel", "telegram"], { home, env }).code).toBe(0);
  return { home, env };
}

/** `taskfollow gateway start` without waiting for it, so two can race; resolves with its JSON line. */
const startAsync = (home: string, env: Record<string, string>): Promise<{ pid: number }> =>
  new Promise((done, fail) => {
    execFile(process.execPath, [resolve("dist/cli.js"), "--home", home, "gateway", "start"], { env: { ...process.env, ...env } }, (error, stdout) => (error ? fail(error) : done(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { pid: number })));
  });

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

describe("taskfollow gateway start | stop | status (D72)", () => {
  it("starts a detached gateway that serves the channel, reports it, and stops it", async () => {
    const { home, env } = await install();
    const started = runCli(["gateway", "start"], { home, env });
    expect(started.code).toBe(0);
    const { pid } = started.json as { pid: number };
    expect(started.json).toMatchObject({ status: "started", pid: expect.any(Number) });
    expect(runCli(["gateway", "start"], { home, env }).json).toMatchObject({ status: "running", pid, note: "The gateway is already running" });
    const { code } = await createInvite(home, "Grace", undefined, new Date().toISOString());
    await telegram.message(9300, `/join ${code}`);
    await until(async () => (await memberFor(home, { channel: "telegram", address: "9300" }, new Date().toISOString())) !== null);
    expect(runCli(["gateway", "status"], { home, env }).json).toMatchObject({ status: "running", pid, last_round: { approvals: expect.any(String) } });
    expect((await stat(join(home, LOG_FILE))).mode & 0o777).toBe(0o600);
    expect(runCli(["gateway", "stop"], { home, env }).json).toEqual({ status: "stopped", pid });
    await waitForExit(pid);
    expect(runCli(["gateway", "status"], { home, env }).json).toEqual({ status: "stopped" });
  });

  it("replaces a gateway that died without cleaning up (crash-safe restart)", async () => {
    const { home, env } = await install();
    const first = (runCli(["gateway", "start"], { home, env }).json as { pid: number }).pid;
    process.kill(first, "SIGKILL");
    await waitForExit(first);
    expect(runCli(["gateway", "status"], { home, env }).json).toMatchObject({ status: "stale", pid: first });
    const restarted = runCli(["gateway", "start"], { home, env }).json as { pid: number; note: string };
    expect(restarted).toMatchObject({ status: "started", note: `Replaced a gateway that had stopped without cleaning up (pid ${first})` });
    expect(restarted.pid).not.toBe(first);
    expect(runCli(["gateway", "stop"], { home, env }).json).toMatchObject({ status: "stopped" });
    await waitForExit(restarted.pid);
  });

  it("leaves exactly one gateway when two starts race for the pid file (D103)", async () => {
    const { home, env } = await install();
    const [first, second] = await Promise.all([startAsync(home, env), startAsync(home, env)]);
    expect(first?.pid).toBe(second?.pid);
    expect(runCli(["gateway", "status"], { home, env }).json).toMatchObject({ status: "running", pid: first?.pid });
    expect(runCli(["gateway", "stop"], { home, env }).json).toMatchObject({ status: "stopped", pid: first?.pid });
    await waitForExit(first?.pid ?? 0);
  });

  it("refuses to start with no channel, says when nothing runs, and names its subcommands", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const refused = runCli(["gateway", "start"], { home });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("No channel is set up yet") });
    expect(runCli(["gateway", "stop"], { home }).json).toEqual({ status: "not_running" });
    expect(runCli(["gateway", "restart"], { home }).json).toEqual({ error: "gateway needs one of: start, stop, status", code: 2 });
  });
});
