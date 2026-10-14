import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPORT_CONFIG } from "../../src/core/daily-report.js";
import { writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { ENGINE_USER, SERVICE_DIR, dedicatedUserSteps, quietWindow, serviceCommand } from "../../src/core/host-service.js";
import { READINESS_FILE, hostCommand, hostReadiness, type HostProbe } from "../../src/core/host.js";
import { loadState, saveState } from "../../src/core/state.js";
import type { InstallState, Mode } from "../../src/core/types.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const SERVICE = { node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: ENGINE_USER };

/** A fake OS: answers by the command line; records every command it was asked to run. */
function fakeHost(platform: NodeJS.Platform, answers: Record<string, string | null>, installed = false): HostProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform, calls,
    run: async (argv) => {
      calls.push(argv.join(" "));
      const stdout = answers[argv.join(" ")];
      return stdout === null || stdout === undefined ? { code: null, stdout: "" } : { code: 0, stdout };
    },
    exists: async () => installed,
  };
}

const MAC_READY = { "pmset -g": "System-wide power settings:\n displaysleep         10\n sleep                0\n autorestart          1\n", "systemsetup -getusingnetworktime": "Network Time: On\n", "fdesetup status": "FileVault is On.\n" };
const MAC_ASLEEP = { "pmset -g": " disksleep 10\n sleep 10 (sleep prevented by coreaudiod)\n autorestart 0\n", "systemsetup -getusingnetworktime": "Network Time: On\n", "fdesetup status": "FileVault is Off.\n" };

async function homeWith(mode: Mode): Promise<{ home: string; state: InstallState }> {
  const home = await runnerHome();
  const state = { ...((await loadState(home)) as InstallState), mode };
  await saveState(home, state);
  return { home, state };
}

const statuses = (readiness: { checks: readonly { id: string; status: string }[] }) => Object.fromEntries(readiness.checks.map((entry) => [entry.id, entry.status]));

describe("host readiness, Layer 1 (§5.1, D42, D104)", () => {
  it("scores a ready macOS team host 5/5 and prints the dedicated-user steps", async () => {
    const { home, state } = await homeWith("team_host");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", MAC_READY, true), AT);
    expect(readiness).toMatchObject({ applies: true, score: "5/5", mode: "team_host" });
    expect(statuses(readiness)).toEqual({ no_sleep: "ok", power_on: "ok", boot_service: "ok", time_sync: "ok", disk_encryption: "ok", updates: "advice", power_network: "advice" });
    expect(readiness.dedicated_user?.join(" ")).toContain(ENGINE_USER);
  });

  it("prints the fixes for a Mac that sleeps, stays off after a power cut and has no FileVault, and only reads settings", async () => {
    const { home, state } = await homeWith("team_host");
    const probe = fakeHost("darwin", MAC_ASLEEP);
    const readiness = await hostReadiness(home, state, probe, AT);
    expect(readiness.score).toBe("1/5");
    const fixes = Object.fromEntries(readiness.checks.map((entry) => [entry.id, entry.fix]));
    expect(fixes.no_sleep).toEqual(["sudo pmset -a sleep 0"]);
    expect(fixes.power_on).toEqual(["sudo pmset -a autorestart 1"]);
    expect(fixes.boot_service).toEqual(["taskpilot host service install", "then run the sudo commands it prints, in your own terminal"]);
    expect(fixes.disk_encryption?.[0]).toContain("the engine never stores it (D43)");
    expect(probe.calls).toEqual(["pmset -g", "systemsetup -getusingnetworktime", "fdesetup status"]);
  });

  it("reads a Linux host with systemctl, timedatectl and lsblk; the firmware power setting is the person's to check", async () => {
    const { home, state } = await homeWith("hybrid");
    const probe = fakeHost("linux", { "systemctl is-enabled sleep.target suspend.target hibernate.target hybrid-sleep.target": "masked\nmasked\nmasked\nmasked\n", "timedatectl show -p NTPSynchronized --value": "yes\n", "lsblk -rno TYPE": "disk\npart\ncrypt\n" });
    const readiness = await hostReadiness(home, state, probe, AT);
    expect(readiness.score).toBe("3/4");
    expect(statuses(readiness)).toMatchObject({ no_sleep: "ok", power_on: "manual", boot_service: "fix", time_sync: "ok", disk_encryption: "ok" });
  });

  it("only informs on a Personal-mode laptop: no fixes, and says why scheduled jobs may be skipped", async () => {
    const { home, state } = await homeWith("personal");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", MAC_ASLEEP), AT);
    expect(readiness).toMatchObject({ applies: false, note: expect.stringContaining("skipped while this computer sleeps") });
    expect(readiness.checks.some((entry) => entry.fix !== undefined)).toBe(false);
    expect(readiness.dedicated_user).toBeUndefined();
  });

  it("counts what it cannot read as not yet verified", async () => {
    const { home, state } = await homeWith("team_host");
    const readiness = await hostReadiness(home, state, fakeHost("darwin", { "pmset -g": null, "systemsetup -getusingnetworktime": "You need administrator access to run this tool... exiting!\n", "fdesetup status": null }), AT);
    expect(statuses(readiness)).toMatchObject({ no_sleep: "unknown", power_on: "unknown", time_sync: "unknown", disk_encryption: "unknown", boot_service: "fix" });
    expect(readiness.score).toBe("0/5");
  });

  it("finds the quiet window: the longest gap in a day between scheduled runs and reports", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, { workflow: "early", version: 1, trigger: { cron: "0 8 * * *", tz: "UTC" }, steps: [{ id: "note", tool: "memo.add", args: { text: "x" } }] });
    await writeConfig(home, REPORT_CONFIG, { recipients: [{ member: "Owner", tz: "UTC" }], times: ["09:00", "17:00"] });
    expect(await quietWindow(home, AT)).toEqual({ from: "2026-10-08T17:00:00.000Z", to: "2026-10-09T08:00:00.000Z", hours: 15 });
    expect(await quietWindow(await runnerHome(), AT)).toBeNull();
  });

  it("writes the boot service files under the home and prints the sudo commands for the person", async () => {
    const home = await runnerHome();
    const mac = await serviceCommand(home, "install", { ...SERVICE, platform: "darwin" }, () => AT);
    const [gateway = "", tick = ""] = mac.files as string[];
    expect(gateway.startsWith(join(home, SERVICE_DIR))).toBe(true);
    const plist = await readFile(gateway, "utf8");
    expect(plist).toContain(`<key>UserName</key>\n  <string>${ENGINE_USER}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>gateway-serve</string>");
    expect(await readFile(tick, "utf8")).toContain("<key>StartInterval</key>\n  <integer>60</integer>");
    expect(mac.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootstrap system \/Library\/LaunchDaemons\/com\.installer\.gateway\.[0-9a-f]{8}\.plist$/));
    const linux = await serviceCommand(home, "install", { ...SERVICE, platform: "linux" }, () => AT);
    const unit = await readFile((linux.files as string[])[0] ?? "", "utf8");
    expect(unit).toContain(`User=${ENGINE_USER}\nExecStart="/usr/local/bin/node" "/opt/installer/dist/cli.js" "--home" "${home}" "gateway-serve"\nRestart=always`);
    expect(linux.commands).toContainEqual(expect.stringMatching(/^sudo systemctl enable --now installer-gateway-[0-9a-f]{8}\.service$/));
    const removed = await serviceCommand(home, "remove", { ...SERVICE, platform: "darwin" }, () => AT);
    expect(removed.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootout system\/com\.installer\.gateway\./));
    await expect(access(gateway)).rejects.toThrow();
    await expect(serviceCommand(join(home, "100%"), "install", { ...SERVICE, platform: "linux" }, () => AT)).rejects.toThrow("contains % or a line break");
  });

  it("puts the readiness score into doctor and the report's file; skips it where host checks are off", async () => {
    const { home } = await homeWith("team_host");
    const report = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3, host: fakeHost("darwin", MAC_ASLEEP) });
    expect(report.checks.find((entry) => entry.id === "host")).toMatchObject({ status: "warn", detail: "readiness 1/5; not right yet: no_sleep, power_on, boot_service, disk_encryption" });
    expect(JSON.parse(await readFile(join(home, READINESS_FILE), "utf8"))).toMatchObject({ score: "1/5", applies: true });
    const unread = { ...MAC_READY, "systemsetup -getusingnetworktime": "You need administrator access to run this tool... exiting!\n" };
    const partly = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3, host: fakeHost("darwin", unread, true) });
    expect(partly.checks.find((entry) => entry.id === "host")).toMatchObject({ status: "ok", detail: "readiness 4/5; not read: time_sync" });
    const both = await runDoctor(home, { now: () => AT, freeBytes: async () => 50 * 1024 ** 3, host: fakeHost("darwin", { ...MAC_ASLEEP, "systemsetup -getusingnetworktime": "" }) });
    expect(both.checks.find((entry) => entry.id === "host")).toMatchObject({ status: "warn", detail: "readiness 0/5; not right yet: no_sleep, power_on, boot_service, disk_encryption; not read: time_sync" });
    expect((await runDoctor(home, { now: () => AT })).checks.find((entry) => entry.id === "host")).toMatchObject({ status: "ok", detail: expect.stringContaining("INSTALLER_HOST_CHECKS=none") });
    expect(await hostCommand(home, undefined, undefined, () => AT)).toMatchObject({ status: "skipped" });
    expect(dedicatedUserSteps("linux")[0]).toContain(`sudo useradd --create-home --shell /bin/bash ${ENGINE_USER}`);
  });
});
