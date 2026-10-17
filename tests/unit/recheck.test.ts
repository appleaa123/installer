import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordResult } from "../../src/core/checks.js";
import { readConfig, writeConfig } from "../../src/core/data-source.js";
import { RECHECK_EVERY_MS, RECHECK_FILE, RECHECK_LOCK, recheckDue } from "../../src/core/recheck.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** D174: once a week TaskFollow re-runs preflight T7 on the person's agent, only when there is a pass to keep fresh. */
const NOW = "2026-10-20T09:00:00.000Z";
const DAY_MS = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY_MS).toISOString();

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

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
