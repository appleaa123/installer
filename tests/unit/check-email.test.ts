import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { ActionFailure } from "../../src/core/failure.js";
import { serveCheckPage } from "../../src/core/check-page.js";
import { plantByChannel } from "../../src/core/check-email.js";
import { checkCommand } from "../../src/core/check-commands.js";
import { abilities, loadChallenge } from "../../src/core/checks.js";
import { loadState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Plan Task 8 (spec 5.2 T2): reading email, with a test message TaskFollow plants itself when it can. */
const AT = "2026-10-16T12:00:00.000Z";
const planted: { subject: string; text: string }[] = [];
const launched: { id: string; word: string | undefined }[] = [];
const pages: { close: () => void }[] = [];
afterEach(() => {
  planted.splice(0);
  launched.splice(0);
  pages.splice(0).forEach((page) => page.close());
});
const ctx = (canPlant: boolean) => ({
  interactive: false, now: () => AT,
  launch: async (_home: string, id: string, word: string | undefined) => (launched.push({ id, word }), { pid: 0, opened: true }),
  plant: async (_home: string, subject: string, text: string) => (canPlant ? (planted.push({ subject, text }), true) : false),
});
const run = async (home: string, args: string[], canPlant = true) => checkCommand(home, (await loadState(home)) ?? undefined, args, {}, ctx(canPlant));
const wordOf = (subject: string, id: string) => subject.slice(`TASKFOLLOW-CHECK ${id} `.length);

describe("check T2: reading email (plan Task 8)", () => {
  it("plants the test email itself, says so, and the agent's instruction carries no word", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2"])) as { id: string; instruction: string; planted: string };
    expect(planted).toHaveLength(1);
    expect(planted[0]?.subject).toMatch(new RegExp(`^TASKFOLLOW-CHECK ${out.id} [A-Z]+-[A-Z2-9]{4}$`));
    expect(out.planted).toContain("TaskFollow sent the test email to your own address");
    const word = wordOf(planted[0]?.subject ?? "", out.id);
    expect(out.instruction).toContain(`TASKFOLLOW-CHECK ${out.id}`);
    expect(JSON.stringify(out)).not.toContain(word);
    expect(launched).toEqual([]);
    const audit = await readFile(join(home, AUDIT_FILE), "utf8");
    expect(audit).toContain("check.planted");
    expect(audit).not.toContain(word);
  });

  it("records yes, tested when the agent returns the subject's word, and never stores what it typed", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2"])) as { id: string };
    const word = wordOf(planted[0]?.subject ?? "", out.id);
    expect(await run(home, ["answer", out.id, word.toLowerCase()])).toMatchObject({ need: "reads:email", result: "yes, tested" });
    const stored = JSON.stringify(await abilities(home));
    expect(stored).not.toContain(word);
    expect(stored.toLowerCase()).not.toContain(word.toLowerCase());
  });

  it("records an answer typed at an interactive terminal as 'was that you?', not as the agent's (review M6)", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2"])) as { id: string };
    const word = wordOf(planted[0]?.subject ?? "", out.id);
    const typed = await checkCommand(home, (await loadState(home)) ?? undefined, ["answer", out.id, word], {}, { ...ctx(true), interactive: true });
    expect(typed).toMatchObject({ result: "not checked", why: expect.stringContaining("interactive terminal") });
  });

  it("lets 'check cannot' close only the email check, never another open check (review M2)", async () => {
    const home = await runnerHome();
    const other = (await run(home, ["start", "t1"])) as { id: string };
    await expect(run(home, ["cannot", other.id])).rejects.toThrow("only for the email check");
    expect((await loadChallenge(home, other.id))?.status).toBe("open");
    await expect(run(home, ["nonsense"])).rejects.toThrow(/cannot <id>/);
  });

  it("falls back to the person's page when planting fails, and audits it without the word (review H4)", async () => {
    const home = await runnerHome();
    const failing = { interactive: false, now: () => AT, launch: async (_home: string, id: string, word: string | undefined) => (launched.push({ id, word }), { pid: 0, opened: true }), plant: async () => { throw new ActionFailure("No email secret is stored"); } };
    const out = (await checkCommand(home, (await loadState(home)) ?? undefined, ["start", "t2"], {}, failing)) as { id: string; page: string };
    expect(out.page).toContain("opened in the person's browser");
    expect(launched).toHaveLength(1);
    const audit = await readFile(join(home, AUDIT_FILE), "utf8");
    expect(audit).toContain("check.plant_failed");
    expect(audit).not.toContain(launched[0]?.word ?? "nothing");
  });

  it("opens the person's page with the word and the subject to send when TaskFollow cannot plant", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2"], false)) as { id: string; page: string; instruction: string };
    expect(planted).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(out.page).toContain("opened in the person's browser");
    const word = launched[0]?.word ?? "";
    const page = await serveCheckPage(home, out.id, { word, now: () => AT, ttlMs: 60_000 });
    pages.push(page);
    const shown = await (await fetch(`${page.url}/show`, { method: "POST", headers: { origin: new URL(page.url).origin } })).text();
    expect(shown).toContain(`TASKFOLLOW-CHECK ${out.id} ${word}`);
    expect(shown).toContain("from your phone");
  });

  it("records 'blocked, not an ability problem' when the agent cannot reach email, without its words", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t2"])) as { id: string };
    expect(await run(home, ["cannot", out.id])).toMatchObject({ need: "reads:email", result: "not checked", why: expect.stringContaining("not an ability problem") });
    expect((await loadChallenge(home, out.id))?.status).toBe("done");
  });

  it("plants nothing when TaskFollow has no email channel", async () => {
    expect(await plantByChannel(await runnerHome(), "TASKFOLLOW-CHECK c00000000 X", "x")).toBe(false);
  });
});
