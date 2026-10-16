import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { habits, noticeHabits, takeSuggestions } from "../../src/core/watch-notice.js";
import { InputError } from "../../src/core/inputs.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { readFile } from "node:fs/promises";
const readAuditLines = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { event: string });
import { watchCommand } from "../../src/core/watch.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

const NOW = "2026-10-28T09:00:00.000Z";

async function callsOn(home: string, days: readonly string[], line: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, "data", "agent-calls"), { recursive: true });
  for (const day of days) await writeFile(join(home, "data", "agent-calls", `${day}.jsonl`), `${JSON.stringify({ ts: `${day}T10:00:00.000Z`, session: "s", ...line })}\n`, { flag: "a" });
}
const days = (count: number, from = 1) => Array.from({ length: count }, (_, index) => `2026-10-${String(from + index).padStart(2, "0")}`);
const env = async () => ({ INSTALLER_CLAUDE_SETTINGS: join(await makeTempHome(), "settings.json") });

describe("noticing work done often through the agent (D148)", () => {
  it("counts, per watched service, the days in the last four weeks with a direct call", async () => {
    const home = await runnerHome();
    await callsOn(home, days(6), { tool: "mcp__shopify__get_order", what: "id" });
    await callsOn(home, days(2, 10), { tool: "Bash", what: "shopify store execute" });
    await callsOn(home, ["2026-09-01"], { tool: "mcp__shopify__get_order", what: "id" });
    await callsOn(home, days(3), { tool: "mcp__installer__actions_reason", reason_for: "x", why: "y" });
    expect(await habits(home, ["mcp:shopify", "cli:shopify"], NOW)).toEqual({ "mcp:shopify": 6, "cli:shopify": 2 });
  });

  it("tells only the person who asked for suggestions, once per service, and changes nothing", async () => {
    const home = await runnerHome();
    const settings = await env();
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, () => NOW, settings);
    await callsOn(home, days(6), { tool: "mcp__shopify__get_order", what: "id" });
    const sent: { member: string; text: string }[] = [];
    const notify = async (member: string, text: string) => void sent.push({ member, text });
    expect(await noticeHabits(home, () => NOW, notify)).toEqual([]);
    await watchCommand(home, { sub: "suggest", arg: "Sam", interactive: true }, () => NOW, settings);
    expect(await noticeHabits(home, () => NOW, notify)).toEqual(["mcp:shopify"]);
    expect(sent).toEqual([{ member: "Sam", text: expect.stringMatching(/I noticed .*shopify.* on 6 of the last 28 days.*Nothing changes unless you say so/s) }]);
    expect(await noticeHabits(home, () => "2026-10-29T09:00:00.000Z", notify)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("looks at most once a day, and not for a service used on fewer than five days", async () => {
    const home = await runnerHome();
    const settings = await env();
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, () => NOW, settings);
    await watchCommand(home, { sub: "suggest", arg: "Sam", interactive: true }, () => NOW, settings);
    await callsOn(home, days(4), { tool: "mcp__shopify__get_order", what: "id" });
    const sent: string[] = [];
    expect(await noticeHabits(home, () => NOW, async (_member, text) => void sent.push(text))).toEqual([]);
    await callsOn(home, ["2026-10-20", "2026-10-21"], { tool: "mcp__shopify__get_order", what: "id" });
    expect(await noticeHabits(home, () => "2026-10-28T15:00:00.000Z", async (_member, text) => void sent.push(text))).toEqual([]);
    expect(await noticeHabits(home, () => "2026-10-29T09:00:00.000Z", async (_member, text) => void sent.push(text))).toEqual(["mcp:shopify"]);
  });

  it("is switched on and off by the person only", async () => {
    const home = await runnerHome();
    const settings = await env();
    await expect(watchCommand(home, { sub: "suggest", arg: "Sam", interactive: false }, () => NOW, settings)).rejects.toThrow("own terminal");
    await watchCommand(home, { sub: "suggest", arg: "Sam", interactive: true }, () => NOW, settings);
    expect(await watchCommand(home, { sub: "list", interactive: false }, () => NOW, settings)).toMatchObject({ suggest_to: "Sam" });
    await watchCommand(home, { sub: "suggest", arg: "off", interactive: true }, () => NOW, settings);
    expect(await watchCommand(home, { sub: "list", interactive: false }, () => NOW, settings)).not.toHaveProperty("suggest_to");
  });
});

describe("a suggestion for a person no channel reaches (D164)", () => {
  async function noticed(home: string) {
    const settings = await env();
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, () => NOW, settings);
    await watchCommand(home, { sub: "suggest", arg: "Sam", interactive: true }, () => NOW, settings);
    await callsOn(home, days(6), { tool: "mcp__shopify__get_order", what: "id" });
  }
  const unreachable = async () => {
    throw new InputError("No joined member is called 'Sam'");
  };

  it("keeps the suggestion for the next session instead of losing it, and still makes it only once", async () => {
    const home = await runnerHome();
    await noticed(home);
    expect(await noticeHabits(home, () => NOW, unreachable)).toEqual(["mcp:shopify"]);
    expect(await noticeHabits(home, () => "2026-10-29T09:00:00.000Z", unreachable)).toEqual([]);
    const shown = await takeSuggestions(home, NOW);
    expect(shown).toEqual([{ at: NOW, text: expect.stringMatching(/I noticed .*shopify.* on 6 of the last 28 days/s) }]);
    expect(await takeSuggestions(home, NOW)).toEqual([]);
    const events = (await readAuditLines(home)).map((line) => line.event);
    expect(events).toContain("watch.noticed");
    expect(events).toContain("watch.noticed_shown");
  });

  it("keeps nothing when the message went out", async () => {
    const home = await runnerHome();
    await noticed(home);
    await noticeHabits(home, () => NOW, async () => undefined);
    expect(await takeSuggestions(home, NOW)).toEqual([]);
  });

  it("does not hide an unexpected failure", async () => {
    const home = await runnerHome();
    await noticed(home);
    await expect(noticeHabits(home, () => NOW, async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  });
});

describe("the tick asks for the daily look (D148)", () => {
  it("runs it; a member no channel reaches gets it at the next session, not an error", async () => {
    const { tick } = await import("../../src/core/tick.js");
    const home = await runnerHome();
    const settings = await env();
    await watchCommand(home, { sub: "add", arg: "mcp:shopify", interactive: true }, () => NOW, settings);
    await watchCommand(home, { sub: "suggest", arg: "Nobody", interactive: true }, () => NOW, settings);
    await callsOn(home, days(6), { tool: "mcp__shopify__get_order", what: "id" });
    const result = await tick(home, () => NOW);
    expect(result.errors.filter((error) => error.startsWith("notice:"))).toEqual([]);
    expect(await takeSuggestions(home, NOW)).toHaveLength(1);
  });
});
