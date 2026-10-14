import { access } from "node:fs/promises";
import { join } from "node:path";
import { wallClock } from "./cron.js";
import { writeConfig } from "./data-source.js";
import { runProcess } from "./headless.js";
import { dedicatedUserSteps, quietWindow, serviceCommand, serviceTargets, type ServiceOptions } from "./host-service.js";
import { InputError } from "./inputs.js";
import { loadState } from "./state.js";
import type { InstallState, Mode } from "./types.js";

/**
 * Host readiness, Layer 1 (spec §5.1, D42, D43, D104). On a Team host or the host side of Hybrid, the engine reads
 * the OS settings that keep the assistant running (never sleeps, powers on after a power cut, starts at boot, clock
 * in sync, disk encrypted) and prints the fix for each one that is not right, for a person with administrator rights
 * to run in their own terminal: the engine never runs `sudo` and never changes the OS. On a Personal-mode laptop
 * the result is information only. Every OS command goes through a `CommandRunner`, so tests answer with fakes.
 */
export const HOST_CHECKS_ENV = "INSTALLER_HOST_CHECKS";
export const READINESS_FILE = join("state", "doctor", "host.json");
const COMMAND_TIMEOUT_MS = 10_000;
const SLEEP_TARGETS = ["sleep.target", "suspend.target", "hibernate.target", "hybrid-sleep.target"];
const PERSONAL_NOTE = "Personal mode: for information only, nothing to change. Scheduled jobs are skipped while this computer sleeps or is off (D38).";

export type CommandRunner = (argv: readonly string[]) => Promise<{ readonly code: number | null; readonly stdout: string }>;

export interface HostProbe {
  readonly platform: NodeJS.Platform;
  readonly run: CommandRunner;
  readonly exists: (path: string) => Promise<boolean>;
}

export type ReadinessStatus = "ok" | "fix" | "manual" | "advice" | "unknown";

export interface ReadinessCheck {
  readonly id: string;
  readonly title: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
  readonly fix?: readonly string[];
}

export interface Readiness {
  readonly mode: Mode | null;
  readonly applies: boolean;
  /** Checks that are right, of those a person can change (`ok`, `fix`, or `unknown`: not yet verified). */
  readonly score: string;
  readonly checked_at: string;
  readonly checks: readonly ReadinessCheck[];
  readonly dedicated_user?: readonly string[];
  readonly note?: string;
}

/** The real OS, read only; null when `INSTALLER_HOST_CHECKS=none` (the test suite: no real OS command ever runs there). */
export function systemProbe(env: Readonly<Record<string, string | undefined>> = process.env): HostProbe | null {
  if (env[HOST_CHECKS_ENV] === "none") return null;
  return {
    platform: process.platform,
    run: async (argv) => {
      const result = await runProcess(argv, "/", COMMAND_TIMEOUT_MS);
      return { code: result.code, stdout: result.stdout };
    },
    exists: async (path) => access(path).then(() => true, () => false),
  };
}

const check = (id: string, title: string, status: ReadinessStatus, detail: string, fix?: readonly string[]): ReadinessCheck => ({ id, title, status, detail, ...(fix ? { fix } : {}) });

/** One `pmset -g` value against what it should be. */
function pmsetCheck(output: { code: number | null; stdout: string }, name: string, want: string, id: string, title: string): ReadinessCheck {
  const value = output.code === 0 ? new RegExp(`^\\s*${name}\\s+(\\d+)`, "m").exec(output.stdout)?.[1] : undefined;
  if (value === undefined) return check(id, title, "unknown", `pmset ${name} could not be read`);
  return value === want ? check(id, title, "ok", `pmset ${name} is ${value}`) : check(id, title, "fix", `pmset ${name} is ${value}, should be ${want}`, [`sudo pmset -a ${name} ${want}`]);
}

async function bootCheck(probe: HostProbe, home: string): Promise<ReadinessCheck> {
  const missing: string[] = [];
  for (const target of serviceTargets(home, probe.platform)) if (!(await probe.exists(target))) missing.push(target);
  const title = "Starts at boot and restarts after a crash";
  if (missing.length === 0) return check("boot_service", title, "ok", "the boot service is installed");
  return check("boot_service", title, "fix", `not installed: ${missing.join(", ")}`, ["installer host service install", "then run the sudo commands it prints, in your own terminal"]);
}

async function macChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  const pmset = await probe.run(["pmset", "-g"]);
  const time = await probe.run(["systemsetup", "-getusingnetworktime"]);
  const vault = await probe.run(["fdesetup", "status"]);
  const clock = "Clock set automatically";
  const timeCheck = /Network Time: On/i.test(time.stdout) ? check("time_sync", clock, "ok", "network time is on")
    : /Network Time: Off/i.test(time.stdout) ? check("time_sync", clock, "fix", "network time is off", ["sudo systemsetup -setusingnetworktime on"])
      : check("time_sync", clock, "unknown", "could not be read without administrator rights: check System Settings → General → Date & Time → Set time and date automatically");
  const disk = "Disk encrypted";
  const vaultCheck = /FileVault is On/i.test(vault.stdout) ? check("disk_encryption", disk, "ok", "FileVault is on")
    : /FileVault is Off/i.test(vault.stdout) ? check("disk_encryption", disk, "fix", "FileVault is off", ["System Settings → Privacy & Security → FileVault → Turn On. Keep the recovery key yourself: the engine never stores it (D43)"])
      : check("disk_encryption", disk, "unknown", "fdesetup status could not be read");
  return [pmsetCheck(pmset, "sleep", "0", "no_sleep", "Never sleeps"), pmsetCheck(pmset, "autorestart", "1", "power_on", "Starts again after a power cut"), await bootCheck(probe, home), timeCheck, vaultCheck];
}

async function linuxChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  const sleep = await probe.run(["systemctl", "is-enabled", ...SLEEP_TARGETS]);
  const states = sleep.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const ntp = (await probe.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"])).stdout.trim();
  const blocks = await probe.run(["lsblk", "-rno", "TYPE"]);
  const never = "Never sleeps";
  return [
    states.length === SLEEP_TARGETS.length ? (states.every((state) => state === "masked") ? check("no_sleep", never, "ok", "sleep and suspend are masked") : check("no_sleep", never, "fix", `sleep targets: ${states.join(", ")}`, [`sudo systemctl mask ${SLEEP_TARGETS.join(" ")}`])) : check("no_sleep", never, "unknown", "systemctl could not be read"),
    check("power_on", "Starts again after a power cut", "manual", "a firmware setting the engine cannot read", ["In the firmware (BIOS/UEFI) setup, set 'Restore on AC power loss' (or 'After power failure') to Power On"]),
    await bootCheck(probe, home),
    ntp === "yes" ? check("time_sync", "Clock in sync", "ok", "NTP synchronized") : ntp === "no" ? check("time_sync", "Clock in sync", "fix", "NTP is not synchronized", ["sudo timedatectl set-ntp true"]) : check("time_sync", "Clock in sync", "unknown", "timedatectl could not be read"),
    blocks.code !== 0 ? check("disk_encryption", "Disk encrypted", "unknown", "lsblk could not be read") : blocks.stdout.split("\n").includes("crypt") ? check("disk_encryption", "Disk encrypted", "ok", "an encrypted (LUKS) volume is in use")
      : check("disk_encryption", "Disk encrypted", "fix", "no encrypted volume found", ["Encryption (LUKS) is chosen when the system is installed: move the engine to an encrypted disk. The engine never stores the unlock key (D43)"]),
  ];
}

/** Advice, never scored: updates in the quiet window (§5.1), wired network and a UPS (D43). */
async function adviceChecks(home: string, platform: NodeJS.Platform, now: string): Promise<ReadinessCheck[]> {
  const window = await quietWindow(home, now);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const detail = window ? `the longest gap between scheduled runs and reports is ${wallClock(window.from, zone)} to ${wallClock(window.to, zone)} (${zone}, ${window.hours} h)` : "nothing is scheduled yet";
  const updates = platform === "darwin"
    ? ["Install macOS updates by hand in that window, or let them install overnight then", "A restart that needs the disk unlocked: a person runs 'sudo fdesetup authrestart' then and types the password (D43)"]
    : ["Set unattended-upgrades' Automatic-Reboot-Time to the window's start"];
  return [
    check("updates", "OS updates and restarts in the quiet window", "advice", detail, updates),
    check("power_network", "Wired network and a UPS", "advice", "a wired connection and a UPS keep short outages from stopping or restarting the host; a cloud server also works", ["Connect by cable; put the host on a UPS"]),
  ];
}

async function platformChecks(probe: HostProbe, home: string): Promise<ReadinessCheck[]> {
  if (probe.platform === "darwin") return macChecks(probe, home);
  if (probe.platform === "linux") return linuxChecks(probe, home);
  return [check("platform", "Supported host", "unknown", `readiness checks for ${probe.platform} are not written yet`)];
}

export async function hostReadiness(home: string, state: InstallState | null, probe: HostProbe, now: string): Promise<Readiness> {
  const mode = state?.mode ?? null;
  const applies = mode === "team_host" || mode === "hybrid";
  const found = [...(await platformChecks(probe, home)), ...(await adviceChecks(home, probe.platform, now))];
  const scored = found.filter((entry) => entry.status === "ok" || entry.status === "fix" || entry.status === "unknown");
  const score = `${scored.filter((entry) => entry.status === "ok").length}/${scored.length}`;
  if (!applies) return { mode, applies, score, checked_at: now, checks: found.map(({ fix: _fix, ...rest }) => rest), note: PERSONAL_NOTE };
  return { mode, applies, score, checked_at: now, checks: found, dedicated_user: dedicatedUserSteps(probe.platform) };
}

export const saveReadiness = (home: string, readiness: Readiness): Promise<void> => writeConfig(home, READINESS_FILE, readiness);

/** `installer host [service install | remove]`: the readiness checks with their printed fixes, or the boot service files. */
export async function hostCommand(home: string, sub: string | undefined, extra: string | undefined, now: () => string, options: ServiceOptions & { probe?: HostProbe | null } = {}): Promise<Record<string, unknown>> {
  if (sub === "service") return serviceCommand(home, extra, options, now);
  if (sub !== undefined) throw new InputError("host takes nothing (the readiness checks) or: service install, service remove");
  const probe = options.probe === undefined ? systemProbe() : options.probe;
  if (!probe) return { status: "skipped", note: `Host checks are switched off here (${HOST_CHECKS_ENV}=none)` };
  const readiness = await hostReadiness(home, await loadState(home), probe, now());
  await saveReadiness(home, readiness);
  return { ...readiness, how: "A person with administrator rights runs each fix in their own terminal; the installer only reads settings and never runs sudo (D42, D104)" };
}
