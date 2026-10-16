import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkCommand, type CheckContext } from "../../src/core/check-commands.js";
import { serveCheckPage } from "../../src/core/check-page.js";
import { abilities, loadChallenge } from "../../src/core/checks.js";
import { SHAPES } from "../../src/core/homes.js";
import type { SheetsClient } from "../../src/core/sheets.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Item 7a Task 1 (spec 5.2 T2 variants): attachment, files, records; the agent never holds the word in an output. */
const AT = "2026-10-16T12:00:00.000Z";
type Planted = { subject: string; text: string; files: { filename: string; bytes: Buffer }[] };
const planted: Planted[] = [];
const launched: { id: string; word: string | undefined }[] = [];
afterEach(() => {
  planted.splice(0);
  launched.splice(0);
});

function fakeSheets() {
  const tabs = new Map<string, { id: number; cells: string[][] }>();
  let next = 100;
  const calls: string[] = [];
  const client: Partial<SheetsClient> = {
    readRows: async (location) => (calls.push(`read ${location.tab}`), tabs.get(location.tab ?? "")?.cells ?? []),
    writeRow: async (location, row, cells) => {
      calls.push(`write ${location.tab} ${row}`);
      const tab = tabs.get(location.tab ?? "");
      if (tab) tab.cells[row - 1] = [...cells];
    },
    addTab: async (_id, title) => {
      calls.push(`add ${title}`);
      tabs.set(title, { id: next, cells: [] });
      return next++;
    },
    deleteTab: async (_id, sheetId) => {
      calls.push(`delete ${sheetId}`);
      for (const [title, tab] of tabs) if (tab.id === sheetId) tabs.delete(title);
    },
  };
  return { tabs, calls, client: client as SheetsClient };
}

const ctx = (extra: Partial<CheckContext> = {}): CheckContext => ({
  interactive: false, now: () => AT,
  launch: async (_home, id, word) => (launched.push({ id, word }), { pid: 0, opened: true }),
  plant: async (_home, subject, text, files) => (planted.push({ subject, text, files: (files ?? []).map((file) => ({ filename: file.filename, bytes: file.bytes })) }), true),
  ...extra,
});
const run = async (home: string, args: string[], context: CheckContext = ctx()) => checkCommand(home, (await loadState(home)) ?? undefined, args, {}, context);
async function withWorkDir(home: string, dir?: string): Promise<string> {
  const work = dir ?? (await mkdtemp(join(tmpdir(), "install-folder-")));
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  return work;
}
const exists = (path: string) => stat(path).then(() => true, () => false);

describe("T2 files (reads:files)", () => {
  it("writes the word into a file in the install folder's taskfollow-check folder, never in the output, and removes it after", async () => {
    const home = await runnerHome();
    const work = await withWorkDir(home);
    const out = (await run(home, ["start", "t2f"])) as { id: string; instruction: string };
    const folder = join(work, "taskfollow-check");
    const [file] = await readdir(folder);
    const word = (await readFile(join(folder, file ?? ""), "utf8")).trim();
    expect(word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect(JSON.stringify(out)).not.toContain(word);
    expect(out.instruction).toContain(join(folder, file ?? ""));
    expect(await run(home, ["answer", out.id, word])).toMatchObject({ need: "reads:files", result: "yes, tested" });
    expect(await exists(join(folder, file ?? ""))).toBe(false);
  });

  it("uses the TaskFollow home on a home-folder install, never the person's home folder", async () => {
    const home = await runnerHome();
    await withWorkDir(home, homedir());
    await run(home, ["start", "t2f"]);
    expect((await readdir(join(home, "taskfollow-check"))).length).toBe(1);
    expect(await exists(join(homedir(), "taskfollow-check"))).toBe(false);
  });
});

describe("T2 attachment (reads:email-attachment)", () => {
  it("plants an email whose subject has no word, with the word only inside the attached file", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2a"])) as { id: string; instruction: string };
    expect(planted).toHaveLength(1);
    expect(planted[0]?.subject).toBe(`TASKFOLLOW-CHECK ${out.id}`);
    const word = planted[0]?.files[0]?.bytes.toString("utf8").trim() ?? "";
    expect(word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect(planted[0]?.text).not.toContain(word);
    expect(JSON.stringify(out)).not.toContain(word);
    expect(await run(home, ["answer", out.id, word])).toMatchObject({ need: "reads:email-attachment", result: "yes, tested" });
  });

  it("falls back to the person's page when TaskFollow cannot plant", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2a"], ctx({ plant: async () => false }))) as { id: string; page: string };
    expect(launched).toHaveLength(1);
    expect(launched[0]?.word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect((await loadChallenge(home, out.id))?.test).toBe("t2a");
  });

  it("offers the file once on the person's page, as a download, when TaskFollow cannot plant", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2a"], ctx({ plant: async () => false }))) as { id: string };
    const word = launched[0]?.word ?? "";
    const page = await serveCheckPage(home, out.id, { word, now: () => AT, ttlMs: 60_000 });
    try {
      const origin = new URL(page.url).origin;
      expect(await (await fetch(page.url)).text()).toContain(`TASKFOLLOW-CHECK ${out.id}`);
      const first = await fetch(`${page.url}/show`, { method: "POST", headers: { origin } });
      expect(first.headers.get("content-disposition")).toContain("attachment");
      expect((await first.text()).trim()).toBe(word);
      expect(await (await fetch(`${page.url}/show`, { method: "POST", headers: { origin } })).text()).toContain("already shown");
    } finally {
      page.close();
    }
  });

  it("is the need invoice processing declares", () => {
    expect(SHAPES["invoice-processing"]?.needs).toContain("reads:email-attachment");
  });
});

describe("T2 records (reads:records)", () => {
  it("adds its own tab at the end, writes the word in A1, and removes the tab after the answer", async () => {
    const home = await runnerHome();
    const sheets = fakeSheets();
    const out = (await run(home, ["start", "t2r"], ctx({ sheets: async () => ({ client: sheets.client, spreadsheet_id: "sheet-1" }) }))) as { id: string; instruction: string };
    const tab = `taskfollow-check-${out.id}`;
    expect(sheets.calls[0]).toBe(`add ${tab}`);
    const word = sheets.tabs.get(tab)?.cells[0]?.[0] ?? "";
    expect(word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect(JSON.stringify(out)).not.toContain(word);
    expect(out.instruction).toContain(tab);
    expect(await run(home, ["answer", out.id, word], ctx({ sheets: async () => ({ client: sheets.client, spreadsheet_id: "sheet-1" }) }))).toMatchObject({ need: "reads:records", result: "yes, tested" });
    expect(sheets.tabs.has(tab)).toBe(false);
  });

  it("says plainly it cannot test records without TaskFollow's own sheet connection", async () => {
    const home = await runnerHome();
    expect(await run(home, ["start", "t2r"], ctx({ sheets: async () => null }))).toMatchObject({ need: "reads:records", result: "not checked", why: expect.stringContaining("sheet tab it made") });
    expect((await abilities(home)).at(-1)).toMatchObject({ need: "reads:records", result: "not-checked" });
  });
});
