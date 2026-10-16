import { afterEach, describe, expect, it, vi } from "vitest";
import { serveCheckPage } from "../../src/core/check-page.js";
import { checkCommand } from "../../src/core/check-commands.js";
import { abilities, loadChallenge } from "../../src/core/checks.js";
import { loadState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

/** Spec 2 principle 1, plan Task 7: the work done once, before any test, and the person says whether it looked right. */
const AT = "2026-10-16T12:00:00.000Z";
const NOTE = { workflow: "note", version: 1, description: "Notes the memos", trigger: { manual: true }, steps: [{ id: "list", tool: "memo.list", args: {} }] };
const launched: { id: string; word: string | undefined }[] = [];
const ctx = { interactive: false, now: () => AT, launch: async (_home: string, id: string, word: string | undefined) => (launched.push({ id, word }), { pid: 0, opened: true }) };
const run = async (home: string, args: string[], flags: Record<string, string> = {}) => checkCommand(home, (await loadState(home)) ?? undefined, args, flags, ctx);
const pages: { close: () => void }[] = [];
afterEach(() => {
  pages.splice(0).forEach((page) => page.close());
  launched.splice(0);
});
const post = (url: string, body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(url).origin }, body });

describe("check once: the work done once (plan Task 7)", () => {
  it("runs the workflow once in sandbox, shows its result, and opens the person's page with no word", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, NOTE);
    const out = (await run(home, ["once", "note"])) as { ran: { status: string; sandbox: boolean }; id: string; page: string };
    expect(out.ran).toMatchObject({ status: "completed", sandbox: true });
    expect(out.page).toContain("opened in the person's browser");
    expect(launched).toEqual([{ id: out.id, word: undefined }]);
    expect((await loadChallenge(home, out.id))?.test).toBe("once");
  });

  it("records 'you told us' for answers when the person says it looked right, and not checked when it was wrong", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, NOTE);
    const right = (await run(home, ["once", "note"])) as { id: string };
    const page = await serveCheckPage(home, right.id, { now: () => AT, ttlMs: 60_000 });
    pages.push(page);
    const form = await (await fetch(page.url)).text();
    expect(form).toContain("Did you see the result");
    expect(await (await post(`${page.url}/confirm`, "seen=right")).text()).toContain("Thank you");
    const wrong = (await run(home, ["once", "note"])) as { id: string };
    const second = await serveCheckPage(home, wrong.id, { now: () => AT, ttlMs: 60_000 });
    pages.push(second);
    await post(`${second.url}/confirm`, "seen=wrong");
    const results = (await abilities(home)).filter((entry) => entry.test === "once");
    expect(results.map((entry) => [entry.need, entry.result, entry.workflow])).toEqual([["answers", "yes-you-told-us", "note"], ["answers", "not-checked", "note"]]);
    expect(results[1]?.reason).toContain("wrong");
  });

  it("skips the run when the agent did the work in the chat (read and draft only)", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, NOTE);
    const out = (await run(home, ["once", "note"], { value: JSON.stringify({ by: "chat" }) })) as Record<string, unknown>;
    expect(out.ran).toBeUndefined();
    expect(String(out.note)).toContain("read and draft only");
  });

  it("refuses an unknown workflow", async () => {
    await expect(run(await runnerHome(), ["once", "nope"])).rejects.toThrow(/nope/);
  });
});

describe("check once shows the whole list (item 5)", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("check once shows the whole result", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ tool: "done", summary: "z".repeat(500) }]));
    await writeWorkflow(home, { workflow: "digest", version: 1, mode: "agentic", description: "Lists what needs me", trigger: { manual: true }, instructions: "Read.", tools: ["memo.list"] });
    const out = (await run(home, ["once", "digest"])) as { ran: { result: string } };
    expect(out.ran.result).toBe("z".repeat(500));
  });
});
