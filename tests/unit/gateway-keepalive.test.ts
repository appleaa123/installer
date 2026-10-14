import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { PID_FILE, keepGatewayRunning } from "../../src/core/gateway-process.js";
import { tick } from "../../src/core/tick.js";
import { channelHome } from "../helpers/channel-home.js";
import { deadPid } from "../helpers/dead-pid.js";
import { runnerHome } from "../helpers/runner-home.js";

const NOW = () => "2026-10-08T12:00:00.000Z";

async function writePid(home: string, pid: number): Promise<void> {
  await mkdir(dirname(join(home, PID_FILE)), { recursive: true });
  await writeFile(join(home, PID_FILE), JSON.stringify({ pid, started_at: NOW() }), "utf8");
}

const starter = () => {
  const started: string[] = [];
  return { started, start: async (home: string) => (started.push(home), { status: "started" }) };
};

describe("keeping the gateway alive without a boot service (D130)", () => {
  it("starts it again when it died unexpectedly (a restart or a sign-out leaves a stale record)", async () => {
    const home = await channelHome(true);
    await writePid(home, deadPid());
    const { started, start } = starter();
    expect(await keepGatewayRunning(home, NOW, {}, start)).toBe("started");
    expect(started).toEqual([home]);
  });

  it("leaves a running gateway alone", async () => {
    const home = await channelHome(true);
    await writePid(home, process.pid);
    const { started, start } = starter();
    expect(await keepGatewayRunning(home, NOW, {}, start)).toBe("running");
    expect(started).toEqual([]);
  });

  it("does not start one the person stopped on purpose (stop removes the record)", async () => {
    const home = await channelHome(true);
    const { started, start } = starter();
    expect(await keepGatewayRunning(home, NOW, {}, start)).toBe("stopped");
    expect(started).toEqual([]);
  });

  it("starts nothing when no channel is set up", async () => {
    const home = await runnerHome();
    await writePid(home, deadPid());
    const { started, start } = starter();
    expect(await keepGatewayRunning(home, NOW, {}, start)).toBe("no_channel");
    expect(started).toEqual([]);
  });

  it("can be switched off, as the test suite does", async () => {
    const home = await channelHome(true);
    await writePid(home, deadPid());
    const { started, start } = starter();
    expect(await keepGatewayRunning(home, NOW, { INSTALLER_GATEWAY_AUTOSTART: "none" }, start)).toBe("skipped");
    expect(started).toEqual([]);
  });

  it("is part of every tick, and the tick says what it did", async () => {
    const home = await channelHome(true);
    await writePid(home, deadPid());
    const { started, start } = starter();
    const result = await tick(home, NOW, {}, start);
    expect(result.gateway).toBe("started");
    expect(started).toEqual([home]);
  });
});
