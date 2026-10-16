import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCommand, type CheckContext } from "../../src/core/check-commands.js";
import { abilities, loadChallenge, markChallenge } from "../../src/core/checks.js";
import type { SheetsClient } from "../../src/core/sheets.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Item 7a Task 2 (spec 5.2 T3): writing, proven by TaskFollow reading the target back itself. */
const AT = "2026-10-16T12:00:00.000Z";
const tabs = new Map<string, string[][]>();
const fake: Partial<SheetsClient> = {
  readRows: async (location) => tabs.get(location.tab ?? "") ?? [],
  writeRow: async (location, row, cells) => {
    const rows = tabs.get(location.tab ?? "") ?? [];
    rows[row - 1] = [...cells];
    tabs.set(location.tab ?? "", rows);
  },
  addTab: async (_id, title) => (tabs.set(title, []), 7),
  deleteTab: async () => void tabs.clear(),
};
const ctx: CheckContext = { interactive: false, now: () => AT, launch: async () => ({ pid: 0, opened: false }), sheets: async () => ({ client: fake as SheetsClient, spreadsheet_id: "s1" }) };
const run = async (home: string, args: string[], flags: Record<string, unknown> = {}) => checkCommand(home, (await loadState(home)) ?? undefined, args, flags, ctx);
async function install() {
  const home = await runnerHome();
  const work = await mkdtemp(join(tmpdir(), "install-folder-"));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  return { home, work };
}
const wordIn = (instruction: string) => /this word, and nothing else[^:]*: ([A-Z]+-[A-Z2-9]{4})/.exec(instruction)?.[1] ?? "";
const pathIn = (instruction: string) => /into the file (\S+) /.exec(instruction)?.[1] ?? "";

describe("T3 writing (writes:files, writes:records)", () => {
  it("passes when TaskFollow reads the word back from the file it named, whatever the agent typed", async () => {
    const { home, work } = await install();
    const out = (await run(home, ["start", "t3f"])) as { id: string; instruction: string };
    const file = pathIn(out.instruction);
    expect(file.startsWith(join(work, "taskfollow-check"))).toBe(true);
    await writeFile(file, `${wordIn(out.instruction)}\n`);
    expect(await run(home, ["answer", out.id, "done"])).toMatchObject({ need: "writes:files", result: "yes, tested", why: expect.stringContaining("read the word back") });
    expect(await stat(file).then(() => true, () => false)).toBe(false);
  });

  it("does not pass when the file holds something else, or when the agent only sends the word", async () => {
    const { home } = await install();
    const out = (await run(home, ["start", "t3f"])) as { id: string; instruction: string };
    const word = wordIn(out.instruction);
    expect((await markChallenge(home, out.id, word, { interactive: false, via: "cli", through: "mark" }, AT)).id).toBe(0);
    expect((await loadChallenge(home, out.id))?.status).toBe("open");
    await writeFile(pathIn(out.instruction), "something else\n");
    expect(await run(home, ["answer", out.id, word])).toMatchObject({ result: "not checked" });
  });

  it("writes into a tab TaskFollow made and reads it back, then removes the tab", async () => {
    const { home } = await install();
    const out = (await run(home, ["start", "t3r"])) as { id: string; instruction: string };
    const tab = `taskfollow-check-${out.id}`;
    expect(out.instruction).toContain(tab);
    tabs.set(tab, [[wordIn(out.instruction)]]);
    expect(await run(home, ["answer", out.id, "done"])).toMatchObject({ need: "writes:records", result: "yes, tested" });
    expect(tabs.size).toBe(0);
  });

  it("records not checked when no sheet is connected, like the reads variant (review 8 of PR #54)", async () => {
    const home = await runnerHome();
    const out = await checkCommand(home, (await loadState(home)) ?? undefined, ["start", "t3r"], {}, { ...ctx, sheets: async () => null });
    expect(out).toMatchObject({ need: "writes:records", result: "not checked" });
    expect((await abilities(home)).at(-1)).toMatchObject({ need: "writes:records", result: "not-checked", test: "t3r" });
  });

  it("never tests a target TaskFollow did not make, and says how such writes are gated", async () => {
    const { home } = await install();
    expect(await run(home, ["start", "t3f"], { value: '{"target":"/Users/me/crm.csv"}' })).toMatchObject({ result: "not checked", why: expect.stringContaining("approve-agent-call") });
    expect((await abilities(home)).at(-1)).toMatchObject({ need: "writes:files", result: "not-checked" });
    expect(await readFile(join(home, "audit.jsonl"), "utf8").catch(() => "")).not.toContain("crm.csv");
  });
});
