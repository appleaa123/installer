import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { MINUTE_MS, cronTimes } from "./cron.js";
import { loadReportConfig, reportSlots } from "./daily-report.js";
import { InputError } from "./inputs.js";
import { installerCliPath, shellQuote } from "./register.js";
import { TICK_LOG, xml } from "./scheduler.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The host side of Layer 1 (spec §5.1, D42, D43, D104): boot services, the quiet window and the dedicated OS user.
 * `taskpilot host service install` writes a LaunchDaemon (macOS: the gateway with KeepAlive, and the tick every
 * minute) or a systemd unit (Linux: the gateway with Restart=always; the tick stays the engine user's crontab, which
 * cron runs from boot) under `runtime/service/`, and prints the `sudo` commands a person runs in their own terminal.
 * The installer never runs them and never changes the OS itself; it never creates users either.
 */
export const SERVICE_DIR = join("runtime", "service");
export const ENGINE_USER = "installer-engine";
const DAY_MS = 24 * 60 * MINUTE_MS;

export interface ServiceFile {
  readonly name: string;
  readonly system_path: string;
  readonly text: string;
}

export interface ServicePlan {
  readonly files: readonly ServiceFile[];
  readonly install: readonly string[];
  readonly remove: readonly string[];
}

export interface ServiceOptions {
  readonly platform?: NodeJS.Platform;
  readonly node?: string;
  readonly cli?: string;
  readonly user?: string;
}

const tag = (home: string): string => createHash("sha256").update(resolve(home)).digest("hex").slice(0, 8);

function daemonPlist(label: string, argv: readonly string[], user: string, log: string, everyMinute: boolean): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>\n  <string>${xml(label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>`,
    `  <key>UserName</key>\n  <string>${xml(user)}</string>`,
    "  <key>RunAtLoad</key>\n  <true/>",
    everyMinute ? "  <key>StartInterval</key>\n  <integer>60</integer>" : "  <key>KeepAlive</key>\n  <true/>",
    `  <key>StandardOutPath</key>\n  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** systemd unit arguments in double quotes; `%` (specifiers) and line breaks are refused, like the crontab line (D82). */
function unitArg(text: string): string {
  if (/[%\n\r]/.test(text)) throw new InputError(`A systemd unit cannot hold '${text}' (it contains % or a line break): use a home path without them`);
  return `"${text.replace(/[\\"]/g, (char) => `\\${char}`)}"`;
}

function gatewayUnit(argv: readonly string[], user: string, home: string): string {
  return [
    "[Unit]", `Description=taskpilot gateway for ${resolve(home).replace(/[%\n\r]/g, "")}`, "After=network-online.target", "Wants=network-online.target", "",
    "[Service]", `User=${user}`, `ExecStart=${argv.map(unitArg).join(" ")}`, "Restart=always", "RestartSec=5", "",
    "[Install]", "WantedBy=multi-user.target", "",
  ].join("\n");
}

function macPlan(home: string, base: readonly string[], user: string): ServicePlan {
  const absolute = resolve(home);
  const files = [
    { label: `com.installer.gateway.${tag(home)}`, argv: [...base, "gateway-serve"], log: join(absolute, SERVICE_DIR, "gateway.out.log"), everyMinute: false },
    { label: `com.installer.tickd.${tag(home)}`, argv: [...base, "tick"], log: join(absolute, TICK_LOG), everyMinute: true },
  ].map(({ label, argv, log, everyMinute }) => ({ name: `${label}.plist`, system_path: `/Library/LaunchDaemons/${label}.plist`, text: daemonPlist(label, argv, user, log, everyMinute), label }));
  return {
    files,
    install: files.flatMap((file) => [`sudo cp ${shellQuote(join(absolute, SERVICE_DIR, file.name))} ${file.system_path}`, `sudo chown root:wheel ${file.system_path}`, `sudo chmod 644 ${file.system_path}`, `sudo launchctl bootstrap system ${file.system_path}`]),
    remove: files.flatMap((file) => [`sudo launchctl bootout system/${file.label}`, `sudo rm ${file.system_path}`]),
  };
}

function linuxPlan(home: string, base: readonly string[], user: string): ServicePlan {
  const name = `installer-gateway-${tag(home)}.service`;
  const file = { name, system_path: `/etc/systemd/system/${name}`, text: gatewayUnit([...base, "gateway-serve"], user, home) };
  return {
    files: [file],
    install: [`sudo cp ${shellQuote(join(resolve(home), SERVICE_DIR, name))} ${file.system_path}`, "sudo systemctl daemon-reload", `sudo systemctl enable --now ${name}`],
    remove: [`sudo systemctl disable --now ${name}`, `sudo rm ${file.system_path}`, "sudo systemctl daemon-reload"],
  };
}

export function servicePlan(home: string, options: ServiceOptions = {}): ServicePlan {
  const platform = options.platform ?? process.platform;
  const base = [options.node ?? process.execPath, options.cli ?? installerCliPath(), "--home", resolve(home)];
  const user = options.user ?? userInfo().username;
  if (platform === "darwin") return macPlan(home, base, user);
  if (platform === "linux") return linuxPlan(home, base, user);
  throw new InputError(`Boot services on ${platform} are not supported yet`);
}

/** Where the service files live once a person installed them (the readiness check `boot_service` looks there). */
export const serviceTargets = (home: string, platform: NodeJS.Platform): readonly string[] =>
  platform === "darwin" || platform === "linux" ? servicePlan(home, { platform, node: "node", cli: "cli", user: ENGINE_USER }).files.map((file) => file.system_path) : [];

/** `taskpilot host service install | remove`: writes or deletes the files under the home and prints the commands. */
export async function serviceCommand(home: string, sub: string | undefined, options: ServiceOptions, now: () => string): Promise<Record<string, unknown>> {
  if (sub !== "install" && sub !== "remove") throw new InputError("host service takes: install, remove");
  const plan = servicePlan(home, options);
  const paths = [];
  for (const file of plan.files) {
    const path = await confinedPath(home, join(SERVICE_DIR, file.name));
    if (sub === "remove") await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, file.text, { encoding: "utf8", mode: 0o600 });
    }
    paths.push(path);
  }
  await appendAudit(home, { ts: now(), actor: "agent", event: `host.service_${sub}_printed`, ref: SERVICE_DIR, payload: { files: plan.files.map((file) => file.name) } });
  const before = sub === "install" ? ["taskpilot gateway stop", "taskpilot schedule remove (and the commands it prints), if the per-user schedule was loaded"] : [];
  return { ...(sub === "install" ? { files: paths } : {}), commands: [...before, ...(sub === "install" ? plan.install : plan.remove)], note: "A person with administrator rights runs these in their own terminal; the installer never runs sudo and never changes the OS itself (D42, D104)." };
}

/** D50, D61, D104: the steps for a dedicated engine user on a team host, printed for the person; the engine creates no user. */
export function dedicatedUserSteps(platform: NodeJS.Platform): string[] {
  const create = platform === "darwin"
    ? `Create a standard (not administrator) user named ${ENGINE_USER}: System Settings → Users & Groups → Add User. Keep its password yourself.`
    : `Create the user: sudo useradd --create-home --shell /bin/bash ${ENGINE_USER} (then sudo passwd ${ENGINE_USER}, a password you keep).`;
  return [
    create,
    `Sign in as ${ENGINE_USER} (${platform === "darwin" ? "fast user switching" : `sudo -iu ${ENGINE_USER}`}) and install Node 22, your agent and the installer there, so the engine home, its keychain items and the agent's MCP servers belong to that user, not to your own account (D50).`,
    `As ${ENGINE_USER}, run the install in its own folder (taskpilot start …), then 'taskpilot host service install' and run the printed sudo commands from your own administrator account.`,
    "Decide approvals from Telegram, where the sender is proven (D78). The agent also runs as this user, so the terminal-only checks are no boundary against it (D61); keep this account for the assistant alone and never give it administrator rights.",
  ];
}

/** The longest gap in the next 24 hours between scheduled runs and twice-daily reports: where OS updates belong (§5.1). */
export async function quietWindow(home: string, now: string): Promise<{ from: string; to: string; hours: number } | null> {
  const until = new Date(Date.parse(now) + DAY_MS).toISOString();
  const times: number[] = [];
  for (const id of await workflowIds(home)) {
    try {
      const { trigger } = await loadWorkflow(home, id, DEFAULT_TOOLS);
      if (trigger.kind === "cron") times.push(...cronTimes(trigger.cron, trigger.tz, now, until).map(Date.parse));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
    }
  }
  const report = await loadReportConfig(home);
  if (report) for (const recipient of report.recipients) times.push(...reportSlots(report, recipient, now, until).map(Date.parse));
  const sorted = [...new Set(times)].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const gaps = sorted.map((at, index) => ({ at, next: sorted[index + 1] ?? (sorted[0] ?? at) + DAY_MS }));
  const widest = gaps.reduce((best, gap) => (gap.next - gap.at > best.next - best.at ? gap : best));
  return { from: new Date(widest.at).toISOString(), to: new Date(widest.next).toISOString(), hours: Math.round(((widest.next - widest.at) / 3_600_000) * 10) / 10 };
}
