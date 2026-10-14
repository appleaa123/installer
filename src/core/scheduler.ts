import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { nextCronTime } from "./cron.js";
import { readConfig } from "./data-source.js";
import { saveReportConfig } from "./daily-report.js";
import { InputError } from "./inputs.js";
import { installerCliPath, shellQuote, winQuote } from "./register.js";
import { listRuns } from "./runs.js";
import { HEARTBEAT_FILE } from "./tick.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, workflowIds } from "./workflow.js";

/**
 * The OS scheduler entry (D12, D82): one per engine home, running `taskfollow --home <home> tick` every minute.
 * Three backends behind one interface: macOS launchd (a LaunchAgent plist with StartInterval 60), a crontab line
 * (Linux and other Unix) and Windows Task Scheduler (a task XML repeating every minute; Preview, D128). The installer only writes the file, under `runtime/schedule/` in the home, and prints
 * the exact commands; the person runs them in their own terminal (or Plan 9's service setup does). It never runs
 * launchctl or crontab itself, so nothing outside the home changes without the person.
 */
export const SCHEDULE_DIR = join("runtime", "schedule");
export const TICK_LOG = join(SCHEDULE_DIR, "tick.log");

export interface ScheduleEntry {
  readonly label: string;
  readonly argv: readonly string[];
  readonly log: string;
  /** The PATH to run with (macOS and Linux): a scheduler starts with almost none, and the agent lives in the person's own folders (D130). */
  readonly path?: string;
}

export interface SchedulerBackend {
  readonly id: "launchd" | "crontab" | "schtasks";
  /** The file must be written as UTF-16LE with a byte order mark (Task Scheduler's XML). */
  readonly utf16?: boolean;
  readonly file: (entry: ScheduleEntry) => string;
  readonly render: (entry: ScheduleEntry) => string;
  readonly install: (path: string, entry: ScheduleEntry) => readonly string[];
  readonly remove: (path: string, entry: ScheduleEntry) => readonly string[];
}

/** `com.installer.tick.<8 hex of the home>`: one entry per home, so two installs on one machine never clash. */
export function tickEntry(home: string, node: string, cli: string, path?: string): ScheduleEntry {
  const absolute = resolve(home);
  const label = `com.installer.tick.${createHash("sha256").update(absolute).digest("hex").slice(0, 8)}`;
  return { label, argv: [node, cli, "--home", absolute, "tick"], log: join(absolute, TICK_LOG), ...(path ? { path } : {}) };
}

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** The PATH written into the scheduler entry: node's own folder, then what the person's shell had, then the system folders. Relative entries are dropped. */
export function schedulePath(shellPath: string, node: string): string {
  const dirs = [dirname(node), ...shellPath.split(":"), ...SYSTEM_PATH].filter((dir) => dir.startsWith("/"));
  return [...new Set(dirs)].join(":");
}

export const xml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A LaunchAgent (launchd.plist(5)): ProgramArguments, StartInterval 60, output to the tick log. */
export function plistText(entry: ScheduleEntry): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>\n  <string>${xml(entry.label)}</string>`,
    `  <key>ProgramArguments</key>\n  <array>\n${entry.argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}\n  </array>`,
    ...(entry.path ? [`  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>${xml(entry.path)}</string>\n  </dict>`] : []),
    "  <key>StartInterval</key>\n  <integer>60</integer>",
    "  <key>RunAtLoad</key>\n  <true/>",
    `  <key>StandardOutPath</key>\n  <string>${xml(entry.log)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(entry.log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** crontab(5): `%` ends the command and a line break ends the entry, so paths with either are refused. */
export function crontabLine(entry: ScheduleEntry): string {
  const unsafe = [...entry.argv, entry.log, ...(entry.path ? [entry.path] : [])].find((part) => /[%\n\r]/.test(part));
  if (unsafe !== undefined) throw new InputError(`A crontab line cannot hold '${unsafe}' (it contains % or a line break): use a home path without them`);
  return `* * * * * ${entry.path ? `PATH=${shellQuote(entry.path)} ` : ""}${entry.argv.map(shellQuote).join(" ")} >> ${shellQuote(entry.log)} 2>&1 # ${entry.label}\n`;
}

/**
 * A Task Scheduler task (Windows, Preview): every minute, in the person's own session so their key store opens, on
 * battery too, one at a time. The tick runs through a hidden console so no window opens each minute. Task Scheduler
 * cannot redirect output, so there is no tick.log on Windows; the heartbeat and the audit record each tick.
 */
export function taskXml(entry: ScheduleEntry): string {
  const args = `--headless ${entry.argv.map(winQuote).join(" ")}`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `  <RegistrationInfo><Description>${xml(entry.label)}</Description></RegistrationInfo>`,
    "  <Triggers>",
    "    <TimeTrigger>",
    "      <Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>",
    "      <StartBoundary>2000-01-01T00:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>false</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Hidden>true</Hidden>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    `  <Actions Context="Author"><Exec><Command>conhost.exe</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
}

const LAUNCH_AGENTS = "~/Library/LaunchAgents";

export const LAUNCHD: SchedulerBackend = {
  id: "launchd",
  file: (entry) => `${entry.label}.plist`,
  render: plistText,
  install: (path, entry) => [`mkdir -p ${LAUNCH_AGENTS}`, `cp ${shellQuote(path)} ${LAUNCH_AGENTS}/${entry.label}.plist`, `launchctl bootstrap gui/$(id -u) ${LAUNCH_AGENTS}/${entry.label}.plist`],
  remove: (_path, entry) => [`launchctl bootout gui/$(id -u)/${entry.label}`, `rm ${LAUNCH_AGENTS}/${entry.label}.plist`],
};

export const CRONTAB: SchedulerBackend = {
  id: "crontab",
  file: (entry) => `${entry.label}.crontab`,
  render: crontabLine,
  install: (path, entry) => [`(crontab -l 2>/dev/null | grep -v ${shellQuote(`# ${entry.label}`)}; cat ${shellQuote(path)}) | crontab -`],
  remove: (_path, entry) => [`crontab -l 2>/dev/null | grep -v ${shellQuote(`# ${entry.label}`)} | crontab -`],
};

export const SCHTASKS: SchedulerBackend = {
  id: "schtasks",
  utf16: true,
  file: (entry) => `${entry.label}.xml`,
  render: taskXml,
  install: (path, entry) => [`schtasks /Create /TN "taskfollow\\${entry.label}" /XML "${path}" /F`],
  remove: (_path, entry) => [`schtasks /Delete /TN "taskfollow\\${entry.label}" /F`],
};

export function backendFor(platform: NodeJS.Platform): SchedulerBackend {
  if (platform === "win32") return SCHTASKS;
  return platform === "darwin" ? LAUNCHD : CRONTAB;
}

/** `install` writes the entry's file under the home; `remove` deletes it. Nothing outside the home is touched. */
async function entryFile(home: string, backend: SchedulerBackend, entry: ScheduleEntry, write: boolean): Promise<string> {
  const path = await confinedPath(home, join(SCHEDULE_DIR, backend.file(entry)));
  if (!write) {
    await rm(path, { force: true });
    return path;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const text = backend.render(entry);
  if (backend.utf16) await writeFile(path, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), { mode: 0o600 });
  else await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** What is scheduled: each workflow's trigger and next time, its last run, and when the runner last ticked. */
async function scheduleList(home: string, now: string): Promise<Record<string, unknown>> {
  const runs = await listRuns(home);
  const workflows = [];
  for (const id of await workflowIds(home)) {
    try {
      const { trigger } = await loadWorkflow(home, id, DEFAULT_TOOLS);
      const last = runs.filter((run) => run.workflow === id).at(-1);
      const next = trigger.kind === "cron" ? nextCronTime(trigger.cron, trigger.tz, now) : null;
      workflows.push({ workflow: id, trigger, next, last_run: last ? { run_id: last.run_id, status: last.status } : null });
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      workflows.push({ workflow: id, error: error.message });
    }
  }
  const heartbeat = ((await readConfig(home, HEARTBEAT_FILE)) as { last?: string } | null)?.last ?? null;
  return { workflows, last_tick: heartbeat, ...(heartbeat === null ? { note: "The runner has never ticked: install the schedule with 'taskfollow schedule install'" } : {}) };
}

export interface ScheduleOptions {
  readonly platform?: NodeJS.Platform;
  readonly node?: string;
  readonly cli?: string;
  /** The PATH to write into the entry; defaults to the PATH of this process (the shell that ran the command). */
  readonly envPath?: string;
}

/** `taskfollow schedule list | install | remove | report [--value <json>]` (D82, D89). */
export async function scheduleCommand(home: string, sub: string | undefined, value: string | undefined, now: () => string, options: ScheduleOptions = {}): Promise<Record<string, unknown>> {
  if (sub === "list" || sub === undefined) return scheduleList(home, now());
  if (sub === "report") return saveReportConfig(home, value, now());
  if (sub !== "install" && sub !== "remove") throw new InputError("schedule needs one of: list, install, remove, report");
  const backend = backendFor(options.platform ?? process.platform);
  const node = options.node ?? process.execPath;
  const entry = tickEntry(home, node, options.cli ?? installerCliPath(), backend.id === "schtasks" ? undefined : schedulePath(options.envPath ?? process.env.PATH ?? "", node));
  const path = await entryFile(home, backend, entry, sub === "install");
  await appendAudit(home, { ts: now(), actor: "agent", event: `schedule.${sub}_printed`, ref: entry.label, payload: { backend: backend.id } });
  const commands = sub === "install" ? backend.install(path, entry) : backend.remove(path, entry);
  return {
    backend: backend.id, label: entry.label, ...(sub === "install" ? { file: path } : {}), commands,
    note: `Ask the person to run these commands in their own terminal; the installer does not change the OS scheduler itself (D82).${sub === "install" ? " Then 'taskfollow schedule list' shows the runner's last tick within a minute." : ""}`,
  };
}
