import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import { recordDirectCall, thinLine } from "../../src/core/watch-record.js";
import { WATCH_MARK, settingsWith, settingsWithout, watchCommand, watchMatcher } from "../../src/core/watch.js";
import { runCli } from "../helpers/cli.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const NOW = () => "2026-10-14T15:00:00.000Z";
const HOOK = "/usr/local/bin/node /opt/taskfollow/dist/watch-hook.js /home/x";
const OTHER_HOOK = { matcher: "Bash", hooks: [{ type: "command", command: "my-own-linter" }] };

async function settingsFile(content?: unknown): Promise<string> {
  const file = join(await makeTempHome(), "settings.json");
  if (content !== undefined) await writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2), { mode: 0o644 });
  return file;
}
const env = (file: string) => ({ INSTALLER_CLAUDE_SETTINGS: file });
const read = async (file: string) => JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;

describe("which calls the personal hook listens to (D146)", () => {
  it("builds its matcher from the watched services only", () => {
    expect(watchMatcher(["mcp:shopify", "mcp:claude_ai_Shopify"])).toBe("^(mcp__(shopify|claude_ai_Shopify)__.*|mcp__installer__actions_reason)$");
    expect(watchMatcher(["mcp:shopify", "cli:shopify"])).toBe("^(mcp__(shopify)__.*|mcp__installer__actions_reason|Bash)$");
    expect(watchMatcher(["cli:shopify"])).toBe("^(mcp__installer__actions_reason|Bash)$");
  });
});

describe("editing the person's Claude Code settings (D146)", () => {
  it("adds one marked PostToolUse entry and keeps everything else as it was", () => {
    const before = { model: "opus", env: { X: "1" }, hooks: { PostToolUse: [OTHER_HOOK], Stop: [{ hooks: [{ type: "command", command: "x" }] }] } };
    const after = settingsWith(before, "^(Bash)$", HOOK);
    expect(after).toMatchObject({ model: "opus", env: { X: "1" }, hooks: { Stop: before.hooks.Stop } });
    expect((after.hooks as { PostToolUse: unknown[] }).PostToolUse).toEqual([OTHER_HOOK, { matcher: "^(Bash)$", hooks: [{ type: "command", command: HOOK, timeout: 5 }] }]);
    expect(before.hooks.PostToolUse).toEqual([OTHER_HOOK]);
  });

  it("replaces its own entry rather than adding a second, and removes only its own", () => {
    const once = settingsWith({ hooks: { PostToolUse: [OTHER_HOOK] } }, "^(Bash)$", HOOK);
    const twice = settingsWith(once, "^(mcp__(shopify)__.*)$", HOOK);
    expect((twice.hooks as { PostToolUse: unknown[] }).PostToolUse).toHaveLength(2);
    expect(settingsWithout(twice)).toEqual({ hooks: { PostToolUse: [OTHER_HOOK] } });
    expect(settingsWithout({ model: "opus" })).toEqual({ model: "opus" });
    expect(HOOK).toContain(WATCH_MARK);
  });

  it("refuses a settings file it cannot read safely, and changes nothing", async () => {
    for (const bad of ["{ // a comment\n}", "not json", JSON.stringify({ hooks: { PostToolUse: {} } }), JSON.stringify([1])]) {
      const home = await runnerHome();
      const file = await settingsFile(bad);
      await expect(watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, NOW, env(file))).resolves.toBeDefined();
      await expect(watchCommand(home, { sub: "on", interactive: true }, NOW, env(file))).rejects.toThrow("settings.json");
      expect(await readFile(file, "utf8")).toBe(bad);
    }
  });
});

describe("taskfollow watch (D146)", () => {
  it("is for the person at their terminal only: the agent can list, not change", async () => {
    const home = await runnerHome();
    const file = await settingsFile({});
    expect(await watchCommand(home, { sub: "list", interactive: false }, NOW, env(file))).toEqual({ on: false, services: [], ask: [] });
    for (const sub of ["on", "off", "add", "remove"]) {
      await expect(watchCommand(home, { sub, arg: "mcp:shopify", interactive: false }, NOW, env(file))).rejects.toThrow("own terminal");
    }
  });

  it("refuses a service that is not mcp:<server> or cli:<tool>", async () => {
    const home = await runnerHome();
    await expect(watchCommand(home, { sub: "add", arg: "shopify", interactive: true }, NOW, env(await settingsFile({})))).rejects.toThrow("mcp:<server> or cli:<tool>");
    await expect(watchCommand(home, { sub: "add", arg: "mcp:a|b", interactive: true }, NOW, env(await settingsFile({})))).rejects.toThrow("mcp:<server> or cli:<tool>");
  });

  it("turns on with a backup, shows what it wrote, follows the watched list, and turns off cleanly", async () => {
    const home = await runnerHome();
    const file = await settingsFile({ model: "opus", hooks: { PostToolUse: [OTHER_HOOK] } });
    await expect(watchCommand(home, { sub: "on", interactive: true }, NOW, env(file))).rejects.toThrow("taskfollow watch add");
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, NOW, env(file));
    const on = await watchCommand(home, { sub: "on", interactive: true }, NOW, env(file));
    expect(on).toMatchObject({ on: true, services: ["mcp:shopify"], wrote: { matcher: "^(mcp__(shopify)__.*|mcp__installer__actions_reason)$" } });
    expect(String((on as { restart: string }).restart)).toMatch(/restart/i);
    const backups = await readdir(join(home, "state", "claude-settings-backup"));
    expect(backups).toHaveLength(1);
    expect((await stat(join(home, "state", "claude-settings-backup", backups[0] ?? ""))).mode & 0o777).toBe(0o600);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    await watchCommand(home, { sub: "add", arg: "cli:shopify", interactive: true }, NOW, env(file));
    const entry = ((await read(file)).hooks as { PostToolUse: { matcher: string }[] }).PostToolUse[1];
    expect(entry?.matcher).toBe("^(mcp__(shopify)__.*|mcp__installer__actions_reason|Bash)$");
    await watchCommand(home, { sub: "off", interactive: true }, NOW, env(file));
    expect(await read(file)).toEqual({ model: "opus", hooks: { PostToolUse: [OTHER_HOOK] } });
    expect(await watchCommand(home, { sub: "list", interactive: false }, NOW, env(file))).toEqual({ on: false, services: ["mcp:shopify", "cli:shopify"], ask: [] });
  });

  it("creates the settings file when there is none", async () => {
    const home = await runnerHome();
    const file = join(await makeTempHome(), "sub", "settings.json");
    await watchCommand(home, { sub: "add", arg: "cli:shopify", interactive: true }, NOW, env(file));
    await watchCommand(home, { sub: "on", interactive: true }, NOW, env(file));
    expect(((await read(file)).hooks as { PostToolUse: unknown[] }).PostToolUse).toHaveLength(1);
  });
});

describe("what a direct call leaves behind (D146)", () => {
  it("keeps the tool and the command's first words or the argument names, never their values", () => {
    expect(thinLine({ session_id: "s", tool_name: "Bash", tool_input: { command: "shopify store execute -s a.myshopify.com -q '{customer(email:\"sam@example.com\")}'" }, duration_ms: 300 }, ["cli:shopify"], NOW())).toEqual({ ts: NOW(), session: "s", tool: "Bash", what: "shopify store execute", ms: 300 });
    expect(thinLine({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: { email: "sam@example.com", id: 1001 } }, ["mcp:shopify"], NOW())).toEqual({ ts: NOW(), session: "s", tool: "mcp__shopify__get_order", what: "email, id" });
    expect(thinLine({ session_id: "s", tool_name: "mcp__installer__actions_reason", tool_input: { tool: "mcp__shopify__get_order", why: "the customer asked" } }, ["mcp:shopify"], NOW())).toEqual({ ts: NOW(), session: "s", tool: "mcp__installer__actions_reason", reason_for: "mcp__shopify__get_order", why: "the customer asked" });
  });

  it("ignores Bash commands of tools nobody watches, and calls of other servers", () => {
    expect(thinLine({ session_id: "s", tool_name: "Bash", tool_input: { command: "git status" } }, ["cli:shopify"], NOW())).toBeNull();
    expect(thinLine({ session_id: "s", tool_name: "Bash", tool_input: { command: "FOO=1 shopify store execute" } }, ["cli:shopify"], NOW())).toBeNull();
    expect(thinLine({ session_id: "s", tool_name: "mcp__github__create_issue", tool_input: {} }, ["mcp:shopify"], NOW())).toBeNull();
  });

  it("appends one line to the day's file, and never fails the person's session", async () => {
    const home = await runnerHome();
    await recordDirectCall(home, JSON.stringify({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: { id: 1 } }), ["mcp:shopify"], NOW());
    const text = await readFile(join(home, "data", "agent-calls", "2026-10-14.jsonl"), "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    await expect(recordDirectCall(home, "not json", ["mcp:shopify"], NOW())).resolves.toBeUndefined();
    await expect(recordDirectCall("/nonexistent/home", JSON.stringify({ tool_name: "mcp__shopify__x" }), ["mcp:shopify"], NOW())).resolves.toBeUndefined();
  });

  it("runs as Claude Code calls it, exits 0 even when something is wrong, and prints nothing", async () => {
    const home = await runnerHome();
    const file = await settingsFile({});
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, NOW, env(file));
    const hook = resolve("dist/watch-hook.js");
    const { spawnSync } = await import("node:child_process");
    const ok = spawnSync(process.execPath, [hook, home], { input: JSON.stringify({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: { id: 1 } }), encoding: "utf8" });
    expect(ok).toMatchObject({ status: 0, stdout: "" });
    const broken = spawnSync(process.execPath, [hook, "/nonexistent"], { input: "garbage", encoding: "utf8" });
    expect(broken).toMatchObject({ status: 0, stdout: "" });
    const files = await readdir(join(home, "data", "agent-calls"));
    expect(files).toHaveLength(1);
  });
});

describe("taskfollow watch through the CLI", () => {
  it("refuses the agent (no terminal) in plain words", async () => {
    const home = await runnerHome();
    await writePinnedSolution(home, await readFile("solutions/starter.json", "utf8"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, solution: { ref: "file:starter.json", id: "starter", version: "1.6.0" } });
    const file = await settingsFile({});
    const refused = runCli(["watch", "on"], { home, env: env(file) });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("own terminal") });
    expect(await readFile(file, "utf8")).toBe("{}");
  });
});

describe("the record of direct calls, used and cleaned up (D146)", () => {
  async function watchingHome() {
    const home = await runnerHome();
    const file = await settingsFile({ model: "opus" });
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, NOW, env(file));
    await watchCommand(home, { sub: "on", interactive: true }, NOW, env(file));
    return { home, file };
  }

  it("shows a day's direct calls in why, labelled as outside TaskFollow, with the reason when one was given", async () => {
    const { whyCommand } = await import("../../src/core/why.js");
    const home = await runnerHome();
    await recordDirectCall(home, JSON.stringify({ session_id: "s", tool_name: "mcp__installer__actions_reason", tool_input: { tool: "mcp__shopify__get_order", why: "the owner asked about order 1001" } }), ["mcp:shopify"], NOW());
    await recordDirectCall(home, JSON.stringify({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: { id: 1001 } }), ["mcp:shopify"], NOW());
    await recordDirectCall(home, JSON.stringify({ session_id: "t", tool_name: "mcp__shopify__list_orders", tool_input: {} }), ["mcp:shopify"], NOW());
    const why = (await whyCommand(home, "direct", NOW, "2026-10-14")) as { timeline: { who: string; what: string; why: string }[] };
    expect(why.timeline).toEqual([
      { at: NOW(), who: "your agent, directly (outside TaskFollow)", what: "mcp__shopify__get_order (id)", why: "the owner asked about order 1001" },
      { at: NOW(), who: "your agent, directly (outside TaskFollow)", what: "mcp__shopify__list_orders", why: "the agent gave no reason" },
    ]);
    expect(await whyCommand(home, "direct", NOW)).toMatchObject({ day: "2026-10-14" });
  });

  it("is removed from the person's settings by uninstall, before anything else", async () => {
    const { uninstall } = await import("../../src/core/uninstall.js");
    const { home, file } = await watchingHome();
    await uninstall(home, { interactive: true }, NOW, { platform: "darwin", node: "/usr/local/bin/node", cli: "/opt/installer/dist/cli.js", user: "installer-engine", env: { ...process.env, ...env(file) } as Record<string, string> });
    expect(await read(file)).toEqual({ model: "opus" });
  });

  it("is checked by doctor: a hook whose program is gone is reported", async () => {
    const { watchCheck } = await import("../../src/core/doctor-checks.js");
    const { home, file } = await watchingHome();
    const ctx = { home, state: null, now: NOW(), env: env(file), freeBytes: async () => 0, host: null, shadow: false };
    expect(await watchCheck(ctx)).toMatchObject({ id: "watch", status: "ok" });
    const settings = await read(file);
    const broken = JSON.parse(JSON.stringify(settings).replace(/watch-hook\.js/g, "gone/watch-hook.js")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify(broken));
    expect(await watchCheck(ctx)).toMatchObject({ id: "watch", status: "warn", fix: expect.stringContaining("taskfollow watch on") });
    await writeFile(file, JSON.stringify({ model: "opus" }));
    expect(await watchCheck(ctx)).toMatchObject({ id: "watch", status: "warn", detail: expect.stringContaining("no longer") });
  });

  it("keeps direct-call records and settings backups only as long as other records (D102)", async () => {
    const { pruneOld } = await import("../../src/core/retention.js");
    const { utimes } = await import("node:fs/promises");
    const { home } = await watchingHome();
    await recordDirectCall(home, JSON.stringify({ session_id: "s", tool_name: "mcp__shopify__get_order", tool_input: {} }), ["mcp:shopify"], "2026-01-01T00:00:00.000Z");
    const old = new Date("2026-01-02T00:00:00.000Z");
    await utimes(join(home, "data", "agent-calls", "2026-01-01.jsonl"), old, old);
    const [backup] = await readdir(join(home, "state", "claude-settings-backup"));
    await utimes(join(home, "state", "claude-settings-backup", backup ?? ""), old, old);
    const pruned = await pruneOld(home, NOW());
    expect(pruned).toMatchObject({ direct_calls: 1, settings_backups: 1 });
  });
});
