import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serveCheckPage, systemOpener } from "../../src/core/check-page.js";
import { abilities, loadChallenge, startChallenge } from "../../src/core/checks.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-16T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const pages: { close: () => void }[] = [];
afterEach(() => pages.splice(0).forEach((page) => page.close()));

async function serve(home: string, id: string, word?: string, now = () => AT) {
  const page = await serveCheckPage(home, id, { ...(word ? { word } : {}), now, ttlMs: 60_000 });
  pages.push(page);
  return page;
}
const post = (url: string, body = "") => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin }, body });

describe("check page: the opener (plan review 7)", () => {
  it("uses the system's own opener at an absolute path and ignores the environment and PATH", () => {
    const hostile = { INSTALLER_BROWSER: "/tmp/log.sh", PATH: "/tmp/fake:/usr/bin" };
    expect(systemOpener("darwin", hostile)).toMatchObject({ cmd: "/usr/bin/open" });
    expect(systemOpener("linux", hostile)).toMatchObject({ cmd: "/usr/bin/xdg-open" });
    expect(systemOpener("win32", { SYSTEMROOT: "C:\\Windows" })?.cmd).toMatch(/System32.rundll32\.exe$/);
    expect(systemOpener("darwin", { INSTALLER_BROWSER: "none" })).toBeNull();
    expect(systemOpener("darwin", hostile)?.args("http://127.0.0.1:1/x")).toEqual(["http://127.0.0.1:1/x"]);
  });
});

describe("check page: the word, shown once on request", () => {
  it("shows the word only after the person asks, once; a second request cancels the test and says why", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    const page = await serve(home, challenge.id, word);
    const first = await (await fetch(page.url)).text();
    expect(first).toContain("Show me the word");
    expect(first).not.toContain(word ?? "unreachable");
    expect(first).toContain("do not tell your assistant this word");
    const shown = await (await post(`${page.url}/show`)).text();
    expect(shown).toContain(word ?? "unreachable");
    expect((await loadChallenge(home, challenge.id))?.shown_at).toBe(AT);
    const again = await (await post(`${page.url}/show`)).text();
    expect(again).not.toContain(word ?? "unreachable");
    expect(again).toContain("already shown (a reload or another window can cause this)");
    expect((await loadChallenge(home, challenge.id))?.status).toBe("cancelled");
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain("check.cancelled");
  });

  it("refuses a request from another origin", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    const page = await serve(home, challenge.id, word);
    const response = await fetch(`${page.url}/show`, { method: "POST", headers: { origin: "http://evil.example" } });
    expect(response.status).toBe(403);
    expect((await loadChallenge(home, challenge.id))?.shown_at).toBeUndefined();
  });

  it("answers 404 on any other path", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    const page = await serve(home, challenge.id, word);
    expect((await fetch(`${new URL(page.url).origin}/`)).status).toBe(404);
  });
});

describe("check page: the confirmation, a separate page served from disk", () => {
  it("stays closed until it opens, then records what the person typed as 'you told us'", async () => {
    const home = await makeTempHome();
    let now = AT;
    const { challenge, word } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "Claude Cowork", agentVersion: null, ttlMs: 24 * 60 * 60_000, opensAt: later(10), withWord: true }, AT);
    const page = await serve(home, challenge.id, undefined, () => now);
    expect(await (await fetch(`${page.url}/confirm`)).text()).toContain("opens at");
    expect((await post(`${page.url}/confirm`, `word=${encodeURIComponent(word ?? "")}`)).status).toBe(409);
    now = later(11);
    const done = await (await post(`${page.url}/confirm`, `word=${encodeURIComponent((word ?? "").toLowerCase())}`)).text();
    expect(done).toContain("Thank you");
    expect(await abilities(home)).toEqual([expect.objectContaining({ need: "scheduler", result: "yes-you-told-us", challenge: challenge.id })]);
  });

  it("reopens after a restart: a new server reads the same challenge from disk, with no word", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "Claude Cowork", agentVersion: null, ttlMs: 24 * 60 * 60_000, withWord: true }, AT);
    const first = await serve(home, challenge.id, word);
    first.close();
    const second = await serve(home, challenge.id);
    expect(await (await fetch(second.url)).text()).toContain("This test's word was shown in an earlier window or is not shown here");
    const done = await post(`${second.url}/confirm`, `word=${encodeURIComponent(word ?? "")}`);
    expect(done.status).toBe(200);
  });
});
