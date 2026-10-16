import { readFileSync } from "node:fs";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { operate } from "../operator/scripted-operator.js";

/** Plan item 7 Task 8 (spec section 9): a whole consultation, then the same home continued to an install. */
async function pinnedStarter(): Promise<string> {
  const shipped = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { steps: { auto?: { args?: Record<string, unknown> } }[] };
  const probe = shipped.steps[0]?.auto;
  if (probe) probe.args = { profile: "fake-agent" };
  const pinned = join(await makeTempHome(), "starter.json");
  await writeFile(pinned, JSON.stringify(shipped), "utf8");
  return pinned;
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** Every file under a folder (relative paths), for before/after snapshots; a missing folder has none. */
async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort();
}

describe("the consult mode, end to end (D163)", () => {
  it("leaves only its results and the report, and removes the tool registration it made", async () => {
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const agentHome = await makeTempHome();
    const env = { ...keychain, FAKE_AGENT_HOME: agentHome };
    const add = async (home: string): Promise<void> => {
      const result = runCli(["workflow", "add", "brief", "--value", JSON.stringify({ description: "Each morning, tell me what is new.", tools: ["memo.list"], my_rules: "Keep it short." })], { home, env });
      if (result.code !== 0) throw new Error(result.stderr);
      const started = runCli(["check", "start", "t1"], { home, env }).json as { id: string; instruction: string };
      const word = /mark \S+ (\S+)/.exec(started.instruction)?.[1] ?? "";
      if (runCli(["check", "mark", started.id, word], { home, env }).code !== 0) throw new Error("check mark failed");
    };
    const home = await makeTempHome();
    const settingsFile = process.env.INSTALLER_CLAUDE_SETTINGS ?? "";
    const settingsBefore = await readFile(settingsFile, "utf8").catch(() => null);
    const agentBefore = await filesUnder(agentHome);
    const run = await operate({ home, solutionRef: `file:${await pinnedStarter()}`, script: { answers: { "mode.purpose": "consult", "consult.names": "Marisol Okafor, Okafor Realty" }, perform: { "consult.choose": add } }, startArgs: [], env });
    expect(run.final.status).toBe("complete");
    const shown = JSON.stringify(run.calls.map((call) => call.stdout));
    for (const hidden of ["mode.who", "channels.", "workflows.choose", "activate.schedule"]) expect(shown).not.toContain(hidden);
    const state = await loadState(home);
    const work = state?.work_dir ?? "";
    expect(await exists(join(work, ".claude", "skills", "brief"))).toBe(false);
    expect(await exists(join(work, "CLAUDE.md"))).toBe(false);
    expect(await exists(join(agentHome, "mcp", "installer.json"))).toBe(false);
    // Snapshot: the install folder holds no file at all, the agent's MCP registrations are as before, and the
    // agent's own settings file is untouched (PR #55 review M3).
    expect(await filesUnder(work)).toEqual([]);
    expect((await filesUnder(agentHome)).filter((path) => path.startsWith("mcp"))).toEqual(agentBefore.filter((path) => path.startsWith("mcp")));
    expect(await readFile(settingsFile, "utf8").catch(() => null)).toBe(settingsBefore);
    const reports = await readdir(join(home, "exports"));
    expect(reports.some((name) => name.startsWith("consult-report-"))).toBe(true);
    expect(await readFile(join(home, "exports", reports.find((name) => name.startsWith("consult-report-")) ?? ""), "utf8")).toContain("Read it before forwarding");
    expect(runCli(["report"], { home, env }).stdout).toContain("consult-report-");
    expect(await readdir(join(home, "state", "abilities"))).not.toEqual([]);

    const switched = runCli(["add", "install"], { home, env });
    expect(switched.code).toBe(0);
    expect(await readFile(join(work, ".claude", "skills", "brief", "references", "my-rules.md"), "utf8")).toContain("Keep it short.");
    expect(await exists(join(agentHome, "mcp", "installer.json"))).toBe(true);
    expect(runCli(["next"], { home, env }).stdout).toContain("mode.who");
  });
});
