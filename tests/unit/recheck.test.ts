import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { runnerCheck } from "../../src/core/check-runner.js";
import { runnerStopReason } from "../../src/core/check-fresh.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { abilities, freshResult, recordResult } from "../../src/core/checks.js";
import { readConfig, writeConfig } from "../../src/core/data-source.js";
import { RECHECK_EVERY_MS, RECHECK_FILE, RECHECK_LOCK, RECHECK_RETRY_MS, recheckDue, weeklyRecheck, type RecheckState } from "../../src/core/recheck.js";
import { setPaused } from "../../src/core/pause.js";
import { setSandboxMode, saveWorkflowState } from "../../src/core/sandbox.js";
import { loadState, saveState } from "../../src/core/state.js";
import { FAKE_RUNTIME, runnerHome } from "../helpers/runner-home.js";
import { OWNER, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** D174: once a week TaskFollow re-runs preflight T7 on the person's agent, only when there is a pass to keep fresh. */
const NOW = "2026-10-20T09:00:00.000Z";
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
});
afterAll(() => fake.stop());
beforeEach(async () => {
  await useFakeTelegram(fake);
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
});
afterEach(() => vi.unstubAllEnvs());
const script = (calls: unknown[]) => vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls, answer: { done: true } }));
const PING = [{ tool: "mcp__installer__check_ping", input: "from-prompt" }];
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const state = async (home: string): Promise<RecheckState> => ((await readConfig(home, RECHECK_FILE)) as RecheckState | null) ?? {};
const toOwner = async (): Promise<string[]> => (await fake.sent()).filter((message) => message.chat_id === OWNER.address).map((message) => message.text);

async function passedHome(passedAt = ago(10)): Promise<string> {
  const home = await runnerHome();
  await recordResult(home, { need: "runner", result: "yes-tested", reason: "a pass", at: passedAt, agent: "fake-agent", agent_version: "9.9.9", test: "t7" });
  return home;
}

describe("when the weekly re-check is due (D174)", () => {
  it("is not due in a consultation", async () => {
    const home = await passedHome();
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, steps: { "mode.purpose": { status: "done", value: "consult", at: NOW } } });
    await writeConfig(home, RECHECK_FILE, { next: ago(1) });
    expect(await recheckDue(home, NOW)).toBe(false);
  });

  it("is not due for an agent whose profile has no task command", async () => {
    const home = await passedHome();
    const state = await loadState(home);
    if (state?.runtime) await saveState(home, { ...state, runtime: { ...state.runtime, profile: "codex" } });
    await writeConfig(home, RECHECK_FILE, { next: ago(1) });
    expect(await recheckDue(home, NOW)).toBe(false);
  });

  it("is not due before runner or tools ever passed for this agent", async () => {
    const home = await runnerHome();
    await writeConfig(home, RECHECK_FILE, { next: ago(1) });
    expect(await recheckDue(home, NOW)).toBe(false);
  });

  it("the first time, only sets the next check a week after the newest pass, or now if that is past", async () => {
    const recent = await passedHome(ago(2));
    expect(await recheckDue(recent, NOW)).toBe(false);
    expect(await readConfig(recent, RECHECK_FILE)).toMatchObject({ next: new Date(Date.parse(ago(2)) + RECHECK_EVERY_MS).toISOString() });
    const old = await passedHome(ago(20));
    expect(await recheckDue(old, NOW)).toBe(false);
    expect(await readConfig(old, RECHECK_FILE)).toMatchObject({ next: NOW });
  });

  it("is due once next has passed, and not before", async () => {
    const home = await passedHome();
    await writeConfig(home, RECHECK_FILE, { next: new Date(Date.parse(NOW) + 60_000).toISOString() });
    expect(await recheckDue(home, NOW)).toBe(false);
    await writeConfig(home, RECHECK_FILE, { next: NOW });
    expect(await recheckDue(home, NOW)).toBe(true);
  });

  it("is not due while another re-check holds the lock", async () => {
    const home = await passedHome();
    await writeConfig(home, RECHECK_FILE, { next: ago(1) });
    const lock = join(home, RECHECK_LOCK);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, String(process.pid));
    expect(await recheckDue(home, NOW)).toBe(false);
  });

  it("a damaged recheck file is a plain error, not a crash", async () => {
    const home = await passedHome();
    await mkdir(dirname(join(home, RECHECK_FILE)), { recursive: true });
    await writeFile(join(home, RECHECK_FILE), "{ not json");
    await expect(recheckDue(home, NOW)).rejects.toThrow("config/recheck.json is not valid JSON");
  });
});

/** A finished install with Telegram and Owner as decision maker, on the fake agent, whose runner passed 10 days ago. */
async function toldHome(): Promise<string> {
  const home = await channelHome(true);
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, runtime: FAKE_RUNTIME });
  await recordResult(home, { need: "runner", result: "yes-tested", reason: "a pass", at: ago(10), agent: "fake-agent", agent_version: "9.9.9", test: "t7" });
  return home;
}
const at = () => NOW;

describe("the weekly re-check and what it tells (D174)", () => {
  it("a pass refreshes runner and tools for the agent and moves next a week on", async () => {
    const home = await toldHome();
    script(PING);
    expect(await weeklyRecheck(home, at)).toBe("pass");
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "yes-tested", test: "t7", via: "mcp" });
    expect(await freshResult(home, "tools", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "yes-tested" });
    expect(await state(home)).toMatchObject({ next: new Date(Date.parse(NOW) + RECHECK_EVERY_MS).toISOString(), last: { result: "pass" }, errors: 0 });
    expect(await events(home)).toContain("check.recheck");
  }, 60_000);

  it("an old test:t5 tools entry is current after a weekly pass", async () => {
    const home = await toldHome();
    await recordResult(home, { need: "tools", result: "yes-tested", reason: "chat", at: ago(40), agent: "fake-agent", agent_version: "9.9.9", test: "t5" });
    expect(await freshResult(home, "tools", "fake-agent", "9.9.9", NOW)).toBeNull();
    script(PING);
    await weeklyRecheck(home, at);
    expect(await freshResult(home, "tools", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "yes-tested", test: "t7" });
  }, 60_000);

  it("a fail records not checked, moves next a week on, and tells the decision maker through their channel", async () => {
    const home = await toldHome();
    script([]);
    expect(await weeklyRecheck(home, at)).toBe("fail");
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "not-checked" });
    expect(await state(home)).toMatchObject({ next: new Date(Date.parse(NOW) + RECHECK_EVERY_MS).toISOString(), last: { result: "fail" }, errors: 0 });
    expect(await toOwner()).toContainEqual(expect.stringContaining("TaskFollow's weekly check found that it can no longer run your agent"));
  }, 60_000);

  it("a fail with no channel that reaches the person waits for why, once", async () => {
    const home = await passedHome();
    script([]);
    await weeklyRecheck(home, at);
    expect((await state(home)).waiting).toEqual([{ at: NOW, text: expect.stringContaining("TaskFollow's weekly check found") }]);
  }, 60_000);

  it("a fail in sandbox mode, or while paused, waits for why instead of sending", async () => {
    const sandboxed = await toldHome();
    await setSandboxMode(sandboxed, true, "Owner", NOW);
    script([]);
    await weeklyRecheck(sandboxed, at);
    expect((await state(sandboxed)).waiting).toHaveLength(1);
    const paused = await toldHome();
    await setPaused(paused, true, { name: "Owner", actor: "human", via: "terminal" }, NOW);
    script([]);
    await weeklyRecheck(paused, at);
    expect((await state(paused)).waiting).toHaveLength(1);
  }, 60_000);

  it("a channel failure puts the notice in waiting", async () => {
    const home = await toldHome();
    const current = await loadState(home);
    if (current) await saveState(home, { ...current, roles: { decision_maker: "Nobody" } });
    script([]);
    await weeklyRecheck(home, at);
    expect((await state(home)).waiting).toHaveLength(1);
  }, 60_000);

  it("a task that could not run records nothing, tells nobody, and tries again the next day", async () => {
    const home = await toldHome();
    const before = (await abilities(home)).length;
    vi.stubEnv("FAKE_AGENT_TASK", "not json");
    expect(await weeklyRecheck(home, at)).toBe("error");
    expect((await abilities(home)).length).toBe(before);
    expect(await state(home)).toMatchObject({ next: new Date(Date.parse(NOW) + RECHECK_RETRY_MS).toISOString(), last: { result: "error", why: expect.stringContaining("exited with code 1") }, errors: 1 });
    expect((await state(home)).waiting ?? []).toEqual([]);
  }, 60_000);

  it("the third could-not-run in a row records not checked with the error and tells the decision maker", async () => {
    const home = await toldHome();
    vi.stubEnv("FAKE_AGENT_TASK", "not json");
    await weeklyRecheck(home, at);
    await weeklyRecheck(home, at);
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "yes-tested", reason: "a pass" });
    await weeklyRecheck(home, at);
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", NOW)).toMatchObject({ result: "not-checked", reason: expect.stringContaining("exited with code 1") });
    expect(await toOwner()).toContainEqual(expect.stringContaining("could not run three times in a row"));
  }, 60_000);

  it("a pass or a fail resets the count of could-not-run results", async () => {
    const home = await toldHome();
    vi.stubEnv("FAKE_AGENT_TASK", "not json");
    await weeklyRecheck(home, at);
    script(PING);
    await weeklyRecheck(home, at);
    expect((await state(home)).errors).toBe(0);
  }, 60_000);

  it("a pass settled before the task failed stays a pass and does not write last: error", async () => {
    const home = await toldHome();
    const check: typeof runnerCheck = async () => ({ test: "t7", passed: true, why: "settled" });
    expect(await weeklyRecheck(home, at, undefined, check)).toBe("pass");
    expect((await state(home)).last).toMatchObject({ result: "pass" });
  });

  it("an uncaught error in the run still writes last and audits check.recheck", async () => {
    const home = await toldHome();
    const check: typeof runnerCheck = async () => { throw new Error("boom"); };
    await expect(weeklyRecheck(home, at, undefined, check)).rejects.toThrow("boom");
    expect(await state(home)).toMatchObject({ last: { result: "error", why: "boom" }, next: new Date(Date.parse(NOW) + RECHECK_RETRY_MS).toISOString() });
    expect((await state(home)).errors ?? 0).toBe(0);
    expect(await events(home)).toContain("check.recheck");
  });

  it("after a fail, a workflow with declared needs and no results of its own is stopped by the existing rule", async () => {
    const home = await toldHome();
    await saveWorkflowState(home, { workflow: "brief", sandbox: false, shape: "inbox-triage" } as never);
    script([]);
    await weeklyRecheck(home, at);
    expect(await runnerStopReason(home, "brief", (await loadState(home)) ?? undefined, NOW)).toContain("no longer holds");
  }, 60_000);
});
