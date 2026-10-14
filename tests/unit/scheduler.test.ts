import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { CRONTAB, LAUNCHD, SCHEDULE_DIR, SCHTASKS, backendFor, crontabLine, plistText, scheduleCommand, taskXml, tickEntry } from "../../src/core/scheduler.js";
import { tick } from "../../src/core/tick.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";
import { runnerHome } from "../helpers/runner-home.js";

const NOW = () => "2026-10-08T12:30:00.000Z";
const ENTRY = tickEntry("/srv/engine home", "/usr/local/bin/node", "/opt/installer/dist/cli.js");
const OPTIONS = { node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js" };

describe("the OS scheduler entry (D82)", () => {
  it("is one per home: a label from the home, the tick command and a log in the home", () => {
    expect(ENTRY).toEqual({ label: expect.stringMatching(/^com\.installer\.tick\.[0-9a-f]{8}$/), argv: ["/usr/local/bin/node", "/opt/installer/dist/cli.js", "--home", "/srv/engine home", "tick"], log: "/srv/engine home/runtime/schedule/tick.log" });
    expect(tickEntry("/srv/other", "n", "c").label).not.toBe(ENTRY.label);
  });

  it("launchd: a LaunchAgent that runs every 60 seconds and at load", () => {
    expect(plistText(ENTRY)).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "  <key>Label</key>", `  <string>${ENTRY.label}</string>`,
      "  <key>ProgramArguments</key>", "  <array>", "    <string>/usr/local/bin/node</string>", "    <string>/opt/installer/dist/cli.js</string>", "    <string>--home</string>", "    <string>/srv/engine home</string>", "    <string>tick</string>", "  </array>",
      "  <key>StartInterval</key>", "  <integer>60</integer>",
      "  <key>RunAtLoad</key>", "  <true/>",
      "  <key>StandardOutPath</key>", "  <string>/srv/engine home/runtime/schedule/tick.log</string>",
      "  <key>StandardErrorPath</key>", "  <string>/srv/engine home/runtime/schedule/tick.log</string>",
      "</dict>", "</plist>", "",
    ].join("\n"));
    expect(plistText(tickEntry("/srv/a&b<c>", "n", "c"))).toContain("<string>/srv/a&amp;b&lt;c&gt;</string>");
  });

  it("crontab: one line every minute, quoted for the shell, marked with the label", () => {
    expect(crontabLine(tickEntry("/home/it's", "/usr/bin/node", "/opt/cli.js"))).toMatch(/^\* \* \* \* \* '\/usr\/bin\/node' '\/opt\/cli\.js' '--home' '\/home\/it'\\''s' 'tick' >> '\/home\/it'\\''s\/runtime\/schedule\/tick\.log' 2>&1 # com\.installer\.tick\.[0-9a-f]{8}\n$/);
    expect(() => crontabLine(tickEntry("/home/100%", "n", "c"))).toThrow(InputError);
  });

  it("prints the commands for the person; it never runs them", () => {
    expect(LAUNCHD.install("/h/runtime/schedule/x.plist", ENTRY)).toEqual([
      "mkdir -p ~/Library/LaunchAgents", `cp '/h/runtime/schedule/x.plist' ~/Library/LaunchAgents/${ENTRY.label}.plist`, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/${ENTRY.label}.plist`,
    ]);
    expect(LAUNCHD.remove("", ENTRY)).toEqual([`launchctl bootout gui/$(id -u)/${ENTRY.label}`, `rm ~/Library/LaunchAgents/${ENTRY.label}.plist`]);
    expect(CRONTAB.install("/h/x.crontab", ENTRY)).toEqual([`(crontab -l 2>/dev/null | grep -v '# ${ENTRY.label}'; cat '/h/x.crontab') | crontab -`]);
    expect(CRONTAB.remove("", ENTRY)).toEqual([`crontab -l 2>/dev/null | grep -v '# ${ENTRY.label}' | crontab -`]);
  });

  it("picks launchd on macOS, Task Scheduler on Windows and crontab elsewhere", () => {
    expect(backendFor("darwin").id).toBe("launchd");
    expect(backendFor("linux").id).toBe("crontab");
    expect(backendFor("win32").id).toBe("schtasks");
  });
});

describe("Windows Task Scheduler entry (D128, Preview)", () => {
  const WIN = {
    label: "com.installer.tick.abcd1234",
    argv: ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Jo Lee\\taskfollow\\dist\\cli.js", "--home", "C:\\Users\\Jo Lee\\R&D\\home", "tick"],
    log: "C:\\Users\\Jo Lee\\R&D\\home\\runtime\\schedule\\tick.log",
  };

  it("repeats every minute, runs on battery and in the person's own session, and runs one at a time", () => {
    const text = taskXml(WIN);
    expect(text).toContain("<Interval>PT1M</Interval>");
    expect(text).toContain("<StopAtDurationEnd>false</StopAtDurationEnd>");
    expect(text).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(text).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(text).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(text).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(text).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  });

  it("runs the tick through a hidden console, with every argument double-quoted and & escaped for XML", () => {
    const text = taskXml(WIN);
    expect(text).toContain("<Command>conhost.exe</Command>");
    expect(text).toContain('<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\Jo Lee\\taskfollow\\dist\\cli.js&quot; &quot;--home&quot; &quot;C:\\Users\\Jo Lee\\R&amp;D\\home&quot; &quot;tick&quot;</Arguments>');
  });

  it("refuses a home path that quoting cannot protect", () => {
    expect(() => taskXml({ ...WIN, argv: [...WIN.argv.slice(0, 3), "C:\\50%\\home", "tick"] })).toThrow(InputError);
  });

  it("prints schtasks lines that need no administrator rights", () => {
    expect(SCHTASKS.install("C:\\h\\x.xml", WIN)).toEqual([`schtasks /Create /TN "taskfollow\\${WIN.label}" /XML "C:\\h\\x.xml" /F`]);
    expect(SCHTASKS.remove("", WIN)).toEqual([`schtasks /Delete /TN "taskfollow\\${WIN.label}" /F`]);
    expect(SCHTASKS.file(WIN)).toBe(`${WIN.label}.xml`);
  });

  it("writes the file as UTF-16LE with a byte order mark, which schtasks /XML always accepts", async () => {
    const home = await makeTempHome();
    const result = await scheduleCommand(home, "install", undefined, NOW, { platform: "win32", node: "C:\\node.exe", cli: "C:\\cli.js" });
    expect(result).toMatchObject({ backend: "schtasks" });
    const bytes = await readFile(String(result.file));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toContain("PT1M");
  });
});

describe("taskfollow schedule (D82)", () => {
  it("install writes the entry under the home only and returns the commands; remove deletes it", async () => {
    const home = await makeTempHome();
    const installed = await scheduleCommand(home, "install", undefined, NOW, { ...OPTIONS, platform: "linux" });
    const file = join(home, SCHEDULE_DIR, `${String(installed.label)}.crontab`);
    expect(installed).toMatchObject({ backend: "crontab", file, commands: [expect.stringContaining("| crontab -")], note: expect.stringContaining("Ask the person to run these commands") });
    expect(await readFile(file, "utf8")).toBe(crontabLine(tickEntry(home, OPTIONS.node, OPTIONS.cli)));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const removed = await scheduleCommand(home, "remove", undefined, NOW, { ...OPTIONS, platform: "linux" });
    expect(removed).toMatchObject({ backend: "crontab", commands: [expect.stringContaining("grep -v")] });
    await expect(access(file)).rejects.toThrow();
    expect(await readFile(join(home, "audit", "audit.jsonl"), "utf8")).toContain('"event":"schedule.install_printed"');
  });

  it("list shows each workflow's next time and last run, and the last tick", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, { workflow: "morning", version: 1, trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, steps: [{ id: "note", tool: "memo.add", args: { text: "hi" } }] });
    await writeWorkflow(home, { workflow: "broken", version: 1, steps: [] });
    expect(await scheduleCommand(home, "list", undefined, NOW)).toMatchObject({ last_tick: null, note: expect.stringContaining("taskfollow schedule install") });
    await tick(home, () => "2026-10-08T12:00:30.000Z");
    expect(await scheduleCommand(home, undefined, undefined, NOW)).toEqual({
      workflows: [
        { workflow: "broken", error: expect.stringContaining("steps must list at least one step") },
        { workflow: "morning", trigger: { kind: "cron", cron: "0 8 * * 1-5", tz: "America/Toronto", tolerance_minutes: 5 }, next: "2026-10-09T12:00:00.000Z", last_run: { run_id: expect.any(String), status: "completed" } },
      ],
      last_tick: "2026-10-08T12:00:30.000Z",
    });
  });

  it("refuses an unknown subcommand", async () => {
    await expect(scheduleCommand(await makeTempHome(), "start", undefined, NOW)).rejects.toThrow("schedule needs one of: list, install, remove, report");
  });
});
