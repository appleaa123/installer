import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { isPaused } from "../../src/core/pause.js";
import { loadProfileById } from "../../src/core/profile.js";
import { TOOLS_MCP_NAME, registerMcpConfig } from "../../src/core/register.js";
import { SCHEDULE_DIR, scheduleCommand } from "../../src/core/scheduler.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { uninstall } from "../../src/core/uninstall.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OS = { platform: "darwin" as const, node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: "installer-engine" };

/** A home whose fake agent has both MCP servers registered, with keychain items, a loaded schedule and one memo. */
async function installedHome(): Promise<{ home: string; env: Record<string, string> }> {
  const home = await runnerHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, skillswiki: { url: "https://skills.example/mcp" } });
  const profile = await loadProfileById("fake-agent");
  await registerMcpConfig(profile, "skillswiki", JSON.stringify({ type: "http", url: "https://skills.example/mcp" }), home);
  await registerMcpConfig(profile, TOOLS_MCP_NAME, JSON.stringify({ type: "stdio", command: "node" }), home);
  const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  for (const id of ["skillswiki", "telegram", "model"]) await setSecret(id, `value-of-${id}`, env);
  await scheduleCommand(home, "install", undefined, () => AT, OS);
  await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "A business record" });
  return { home, env };
}

const registered = async (home: string, name: string): Promise<boolean> => access(join(home, ".fake-agent", "mcp", `${name}.json`)).then(() => true, () => false);

describe("taskfollow uninstall (§16.4, D109)", () => {
  it("needs a person's terminal: the agent's attempt is refused, audited, and removes nothing", async () => {
    const { home, env } = await installedHome();
    await expect(uninstall(home, { interactive: false }, () => AT, { ...OS, env })).rejects.toThrow("in their own terminal");
    expect((await readFile(join(home, AUDIT_FILE), "utf8"))).toContain('"event":"engine.uninstall_refused"');
    expect(await getSecret("skillswiki", env)).toBe("value-of-skillswiki");
    expect(await registered(home, "skillswiki")).toBe(true);
  });

  it("pauses, unregisters, deletes the keys and the schedule, prints the OS commands, exports the audit and keeps the records", async () => {
    const { home, env } = await installedHome();
    const result = await uninstall(home, { interactive: true, as: "Owner" }, () => AT, { ...OS, env });
    expect(result).toMatchObject({ status: "uninstalled", gateway: "not_running", unregistered: { skillswiki: { unregistered: true }, installer: { unregistered: true } } });
    expect(result.secrets).toMatchObject({ skillswiki: "deleted", telegram: "deleted", model: "deleted", email: "none", google: "none" });
    expect(await isPaused(home)).toBe(true);
    expect([await registered(home, "skillswiki"), await registered(home, TOOLS_MCP_NAME)]).toEqual([false, false]);
    expect(await getSecret("telegram", env)).toBeNull();
    expect(await readdir(join(home, SCHEDULE_DIR))).toEqual([]);
    expect(result.commands).toContainEqual(expect.stringMatching(/^launchctl bootout gui\/\$\(id -u\)\/com\.installer\.tick\.[0-9a-f]{8}$/));
    expect(result.commands).toContainEqual(expect.stringMatching(/^sudo launchctl bootout system\/com\.installer\.gateway\./));
    const exported = result.audit_export as { file: string; lines: number; chain: string };
    expect(exported).toMatchObject({ file: expect.stringContaining(join(home, "exports", "audit-")), chain: "intact" });
    expect((await readFile(exported.file, "utf8")).trim().split("\n")).toHaveLength(exported.lines);
    expect((await stat(exported.file)).mode & 0o777).toBe(0o600);
    expect(await readFile(exported.file, "utf8")).toContain('"event":"engine.uninstalled"');
    expect((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos).toEqual([expect.objectContaining({ text: "A business record" })]);
  });

  it("can run again safely: there is nothing left to remove", async () => {
    const { home, env } = await installedHome();
    await uninstall(home, { interactive: true }, () => AT, { ...OS, env });
    const again = await uninstall(home, { interactive: true }, () => AT, { ...OS, env });
    expect(again).toMatchObject({ status: "uninstalled", unregistered: { skillswiki: { unregistered: false }, installer: { unregistered: false } } });
    expect(Object.values(again.secrets as Record<string, string>)).toEqual(["none", "none", "none", "none", "none", "none", "none"]);
  });
});
