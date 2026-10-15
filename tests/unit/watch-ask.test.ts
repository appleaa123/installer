import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsWithAsk, settingsWithoutAsk, watchCommand } from "../../src/core/watch.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const NOW = () => "2026-10-14T16:00:00.000Z";
const REFUND = "mcp__shopify__create_refund";

async function settingsFile(content: unknown): Promise<string> {
  const file = join(await makeTempHome(), "settings.json");
  await writeFile(file, JSON.stringify(content, null, 2));
  return file;
}
const env = (file: string) => ({ INSTALLER_CLAUDE_SETTINGS: file });
const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("the always-ask list, as Claude Code's own rules (D147)", () => {
  it("adds rules to permissions.ask and keeps every other permission", () => {
    const before = { permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm:*)"], ask: ["WebFetch"] }, model: "opus" };
    const after = settingsWithAsk(before, [REFUND, "WebFetch"]);
    expect(after).toEqual({ permissions: { allow: ["Bash(git status)"], deny: ["Bash(rm:*)"], ask: ["WebFetch", REFUND] }, model: "opus" });
    expect(before.permissions.ask).toEqual(["WebFetch"]);
  });

  it("removes only the rules it was given", () => {
    expect(settingsWithoutAsk({ permissions: { ask: ["WebFetch", REFUND] } }, [REFUND])).toEqual({ permissions: { ask: ["WebFetch"] } });
    expect(settingsWithoutAsk({ permissions: { ask: [REFUND] }, model: "x" }, [REFUND])).toEqual({ model: "x" });
    expect(settingsWithoutAsk({ permissions: { ask: [REFUND], allow: ["WebFetch"] } }, [REFUND])).toEqual({ permissions: { allow: ["WebFetch"] } });
    expect(settingsWithoutAsk({ model: "x" }, [REFUND])).toEqual({ model: "x" });
  });

  it("is set by the person: ask adds a rule, unask removes it, list shows it; the agent can only list", async () => {
    const home = await runnerHome();
    const file = await settingsFile({ permissions: { ask: ["WebFetch"] } });
    await expect(watchCommand(home, { sub: "ask", arg: REFUND, interactive: false }, NOW, env(file))).rejects.toThrow("own terminal");
    expect(await watchCommand(home, { sub: "ask", arg: REFUND, interactive: true }, NOW, env(file))).toMatchObject({ ask: [REFUND], note: expect.stringContaining("now asks") });
    expect((await read(file)).permissions).toEqual({ ask: ["WebFetch", REFUND] });
    expect(await watchCommand(home, { sub: "list", interactive: false }, NOW, env(file))).toMatchObject({ ask: [REFUND] });
    expect(await watchCommand(home, { sub: "unask", arg: REFUND, interactive: true }, NOW, env(file))).toMatchObject({ ask: [], note: expect.stringContaining("no longer asks") });
    expect((await read(file)).permissions).toEqual({ ask: ["WebFetch"] });
  });

  it("never removes a rule the person had before TaskFollow added the same one", async () => {
    const home = await runnerHome();
    const file = await settingsFile({ permissions: { ask: [REFUND] } });
    await watchCommand(home, { sub: "ask", arg: REFUND, interactive: true }, NOW, env(file));
    await watchCommand(home, { sub: "unask", arg: REFUND, interactive: true }, NOW, env(file));
    expect((await read(file)).permissions).toEqual({ ask: [REFUND] });
  });

  it("refuses a rule that is not a tool rule", async () => {
    const home = await runnerHome();
    const file = await settingsFile({});
    for (const bad of ["*", "Bash", "rm -rf", "Bash(x; y)"]) {
      await expect(watchCommand(home, { sub: "ask", arg: bad, interactive: true }, NOW, env(file))).rejects.toThrow("mcp__<server>__<tool>");
    }
  });

  it("is removed by uninstall", async () => {
    const { uninstall } = await import("../../src/core/uninstall.js");
    const home = await runnerHome();
    const file = await settingsFile({ model: "opus" });
    await watchCommand(home, { sub: "ask", arg: REFUND, interactive: true }, NOW, env(file));
    await uninstall(home, { interactive: true }, NOW, { platform: "darwin", node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: "installer-engine", env: { ...process.env, ...env(file) } as Record<string, string> });
    expect(await read(file)).toEqual({ model: "opus" });
  });
});
