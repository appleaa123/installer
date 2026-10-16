import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { ActionFailure } from "../../src/core/failure.js";
import { afterEach, describe, expect, it } from "vitest";
import { serveCheckPage } from "../../src/core/check-page.js";
import { whenWords } from "../../src/core/check-forms.js";
import { checkCommand } from "../../src/core/check-commands.js";
import { abilities, answerChallenge, loadChallenge, markChallenge } from "../../src/core/checks.js";
import { loadState } from "../../src/core/state.js";
import { readZip } from "../../src/core/zip.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** Plan Task 10 (spec 5.2 T8): the agent's own scheduler, in the order that keeps the chat from faking it. */
const AT = "2026-10-16T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const BRIEF = { workflow: "brief", version: 1, description: "Read my inbox and send me a brief", trigger: { manual: true }, steps: [{ id: "list", tool: "memo.list", args: {} }] };
const planted: string[] = [];
const launched: { id: string; word: string | undefined }[] = [];
const pages: { close: () => void }[] = [];
afterEach(() => {
  planted.splice(0);
  launched.splice(0);
  pages.splice(0).forEach((page) => page.close());
});
const ctx = (canPlant: boolean) => ({ interactive: false, now: () => AT, launch: async (_home: string, id: string, word: string | undefined) => (launched.push({ id, word }), { pid: 0, opened: true }), canPlant: async () => canPlant });
const start = async (home: string, canPlant: boolean) => checkCommand(home, (await loadState(home)) ?? undefined, ["start", "t8"], { workflow: "brief", value: JSON.stringify({ agent: "Claude Cowork" }) }, ctx(canPlant)) as Promise<{ id: string; instruction: string; zip: string }>;
const post = (url: string, body = "") => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin }, body });

async function setup(canPlant = true) {
  const home = await runnerHome();
  await writeWorkflow(home, BRIEF);
  const out = await start(home, canPlant);
  const emailWord = launched.at(-1)?.word ?? "";
  const skill = readZip(await readFile(out.zip))[1]?.data.toString("utf8") ?? "";
  const skillWord = /answer with exactly: (\S+)/.exec(skill)?.[1] ?? "";
  const serve = async (now: string) => {
    const page = await serveCheckPage(home, out.id, { word: emailWord, now: () => now, ttlMs: 60_000, plant: async (_home: string, subject: string) => (canPlant ? (planted.push(subject), true) : false) });
    pages.push(page);
    return page;
  };
  return { home, out, emailWord, skillWord, serve };
}

async function walk(serve: (now: string) => Promise<{ url: string }>) {
  const page = await serve(AT);
  await post(`${page.url}/seen`);
  await post(`${page.url}/closed`);
  return page;
}

describe("check T8: the agent's own scheduler (plan Task 10)", () => {
  it("starts with a test skill zip, an instruction with no word, and a confirmation that opens at the scheduled time and lives 24 hours", async () => {
    const { home, out, emailWord, skillWord } = await setup();
    expect(out.instruction).toContain(`TASKFOLLOW-CHECK ${out.id}`);
    expect(out.instruction).toContain(`taskfollow-check-${out.id}`);
    expect(out.instruction).toContain("not a background command, sleep or cron on this computer");
    expect(JSON.stringify(out)).not.toContain(emailWord);
    expect(JSON.stringify(out)).not.toContain(skillWord);
    expect(emailWord).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    expect(skillWord).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    const challenge = await loadChallenge(home, out.id);
    expect(challenge).toMatchObject({ test: "t8", agent: "Claude Cowork", opens_at: later(10), expires_at: new Date(Date.parse(later(10)) + 24 * 3_600_000).toISOString() });
    expect(JSON.stringify(challenge)).not.toContain(emailWord);
  });

  it("names the date and the time zone in the instruction, never 'today' (review M3)", async () => {
    const { out } = await setup();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(out.instruction).toContain(zone);
    expect(out.instruction).not.toMatch(/\btoday\b/);
    expect(whenWords(later(10))).toContain(zone);
  });

  it("walks the checklist: the task seen, the window closed, then TaskFollow plants the email; confirming waits for the set time", async () => {
    const { out, emailWord, serve } = await setup();
    const page = await serve(AT);
    expect(await (await fetch(page.url)).text()).toContain(out.zip);
    expect(await (await post(`${page.url}/confirm`, "email_word=x&skill_word=y&when=around")).text()).toContain("follow the steps first");
    expect(await (await post(`${page.url}/seen`)).text()).toContain("I closed the window");
    expect(planted).toEqual([]);
    await post(`${page.url}/closed`);
    expect(planted).toEqual([`TASKFOLLOW-CHECK ${out.id} ${emailWord}`]);
    const early = await post(`${page.url}/confirm`, "email_word=x&skill_word=y&when=around");
    expect(early.status).toBe(409);
  });

  it.each([
    ["around", ["yes-you-told-us", "yes-you-told-us", "yes-you-told-us"], "around the set time"],
    ["after", ["yes-you-told-us", "yes-you-told-us", "yes-you-told-us"], "well after the set time"],
    ["before", ["not-checked", "not-checked", "not-checked"], "before the set time"],
  ])("maps '%s' to the right results", async (when, expected, phrase) => {
    const { home, out, emailWord, skillWord, serve } = await setup();
    await walk(serve);
    const page = await serve(later(11));
    expect((await post(`${page.url}/confirm`, `email_word=${emailWord}&skill_word=${skillWord.toLowerCase()}&when=${when}`)).status).toBe(200);
    const results = (await abilities(home)).filter((entry) => entry.challenge === out.id);
    expect(results.map((entry) => entry.result)).toEqual(expected);
    expect(results.find((entry) => entry.need === "scheduler")?.reason).toContain(phrase);
    expect(results.find((entry) => entry.need === "skills")?.reason ?? "").toMatch(when === "before" ? /before/ : /cannot tell/);
    expect(results.find((entry) => entry.need === "scheduler")?.while_away).toBe(when === "around" ? true : when === "after" ? false : undefined);
  });

  it("records 'no, tested' for the scheduler only when the person says nothing arrived", async () => {
    const { home, out, serve } = await setup();
    await walk(serve);
    const page = await serve(later(40));
    await post(`${page.url}/confirm`, "when=nothing");
    const results = (await abilities(home)).filter((entry) => entry.challenge === out.id);
    expect(results.map((entry) => [entry.need, entry.result])).toEqual([["scheduler", "no-tested"], ["reads:email", "not-checked"], ["skills", "not-checked"]]);
  });

  it("cancels after two wrong pairs of words", async () => {
    const { home, out, serve } = await setup();
    await walk(serve);
    const page = await serve(later(11));
    await post(`${page.url}/confirm`, "email_word=NO&skill_word=NO&when=around");
    await post(`${page.url}/confirm`, "email_word=NO&skill_word=NO&when=around");
    expect((await loadChallenge(home, out.id))?.status).toBe("cancelled");
  });

  it("shows the subject to write down before the window closes when TaskFollow cannot plant", async () => {
    const { out, emailWord, serve } = await setup(false);
    const page = await serve(AT);
    const next = await (await post(`${page.url}/seen`)).text();
    expect(next).toContain(`TASKFOLLOW-CHECK ${out.id} ${emailWord}`);
    expect(next).toContain("write it down");
  });

  it("never settles a schedule check from the chat: check answer and check.ping are refused, the check stays open, no try is used (review B1)", async () => {
    const { home, out, emailWord, skillWord, serve } = await setup();
    await walk(serve);
    const answered = await answerChallenge(home, out.id, `${emailWord} ${skillWord}`, later(11));
    expect(answered).toMatchObject({ result: "not-checked", reason: expect.stringContaining("never settle a schedule check") });
    const pinged = await markChallenge(home, out.id, `${emailWord} ${skillWord}`, { interactive: false, via: "mcp", through: "ping" }, later(11));
    expect(pinged.result).toBe("not-checked");
    expect(await loadChallenge(home, out.id)).toMatchObject({ status: "open", tries: 0 });
    expect((await abilities(home)).filter((entry) => entry.challenge === out.id)).toEqual([]);
  });

  it("refuses a mark for an assistant whose schedule runs in the cloud, in plain words, and keeps the check open (review B1)", async () => {
    const { home, out, emailWord, skillWord, serve } = await setup();
    await walk(serve);
    const mark = await markChallenge(home, out.id, `${emailWord} ${skillWord}`, { interactive: false, via: "cli", through: "mark" }, later(11));
    expect(mark).toMatchObject({ result: "not-checked", reason: expect.stringContaining("runs in the cloud, so a command on this computer did not come from it") });
    expect(await loadChallenge(home, out.id)).toMatchObject({ status: "open", tries: 0 });
  });

  it("takes a mark from this computer's own scheduler only after the window closed and at or after the set time, as 'you told us' grade at most (review B1)", async () => {
    const local = async () => {
      const home = await runnerHome();
      await writeWorkflow(home, BRIEF);
      const out = (await checkCommand(home, (await loadState(home)) ?? undefined, ["start", "t8"], { workflow: "brief", value: JSON.stringify({ agent: "fake-agent" }) }, ctx(true))) as { id: string; zip: string };
      const emailWord = launched.at(-1)?.word ?? "";
      const skillWord = /answer with exactly: (\S+)/.exec(readZip(await readFile(out.zip))[1]?.data.toString("utf8") ?? "")?.[1] ?? "";
      const serve = async (now: string) => {
        const page = await serveCheckPage(home, out.id, { word: emailWord, now: () => now, ttlMs: 60_000, plant: async (_home: string, subject: string) => (planted.push(subject), true) });
        pages.push(page);
        return page;
      };
      return { home, out, words: `${emailWord} ${skillWord}`, serve };
    };
    const first = await local();
    expect((await loadChallenge(first.home, first.out.id))?.details?.local_scheduler).toBe("yes");
    const tooSoon = await markChallenge(first.home, first.out.id, first.words, { interactive: false, via: "cli", through: "mark" }, later(11));
    expect(tooSoon).toMatchObject({ result: "not-checked", reason: expect.stringContaining("close the assistant's window") });
    expect(await loadChallenge(first.home, first.out.id)).toMatchObject({ status: "open", tries: 0 });
    await walk(first.serve);
    const mark = await markChallenge(first.home, first.out.id, first.words, { interactive: false, via: "cli", through: "mark" }, later(10));
    expect(mark).toMatchObject({ result: "yes-you-told-us", reason: expect.stringContaining("whether that was the assistant's scheduler or a detached command, TaskFollow cannot tell") });
    const second = await local();
    await walk(second.serve);
    const early = await markChallenge(second.home, second.out.id, second.words, { interactive: false, via: "cli", through: "mark" }, later(3));
    expect(early).toMatchObject({ result: "not-checked", reason: expect.stringContaining("before the scheduled time") });
    expect((await loadChallenge(second.home, second.out.id))?.status).toBe("cancelled");
  });

  it("a reopened page that lost its word says so at the close step and does not mark the window closed (review H1)", async () => {
    const { home, out } = await setup();
    const page = await serveCheckPage(home, out.id, { now: () => AT, ttlMs: 60_000 });
    pages.push(page);
    const next = await (await post(`${page.url}/seen`)).text();
    expect(next).toContain("lost its word");
    expect(next).not.toContain("TaskFollow sends the test email");
    const closed = await (await post(`${page.url}/closed`)).text();
    expect(closed).toContain("lost its word");
    expect((await loadChallenge(home, out.id))?.details?.closed_at).toBeUndefined();
  });

  it("when the plant fails, shows the subject to send from the phone instead of failing past the point of no return (review H4)", async () => {
    const { home, out, emailWord } = await setup();
    const page = await serveCheckPage(home, out.id, { word: emailWord, now: () => AT, ttlMs: 60_000, plant: async () => { throw new ActionFailure("No email secret is stored"); } });
    pages.push(page);
    await post(`${page.url}/seen`);
    const response = await post(`${page.url}/closed`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain(`TASKFOLLOW-CHECK ${out.id} ${emailWord}`);
    expect(body).toContain("from your phone");
    const challenge = await loadChallenge(home, out.id);
    expect(challenge?.details).toMatchObject({ plant: "person" });
    expect(challenge?.details?.closed_at).toBeDefined();
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain("check.plant_failed");
  });

  it("ends with the clean-up steps in the app, never 'ask your assistant'", async () => {
    const { emailWord, skillWord, serve } = await setup();
    await walk(serve);
    const page = await serve(later(11));
    const done = await (await post(`${page.url}/confirm`, `email_word=${emailWord}&skill_word=${skillWord}&when=around`)).text();
    expect(done).toContain("Settings, then Skills");
    expect(done).not.toMatch(/ask your assistant to delete/i);
  });
});
