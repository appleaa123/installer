import { access } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordResult } from "../../src/core/checks.js";
import { readConfig } from "../../src/core/data-source.js";
import { RECHECK_FILE, RECHECK_LOCK, startRecheck, type RecheckState } from "../../src/core/recheck.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/**
 * D174, review 7: the real detached `recheck-run` from the built CLI, with fakes only. The child inherits the suite's
 * environment: the fixture profiles (the fake agent, never a real one), a test keychain, and the fake agent's own home.
 */
beforeEach(async () => {
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
  vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls: [{ tool: "mcp__installer__check_ping", input: "from-prompt" }], answer: { done: true } }));
});
afterEach(() => vi.unstubAllEnvs());

async function until(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((tick) => setTimeout(tick, 200));
  }
}

describe("taskfollow recheck-run, the real child (D174)", () => {
  it("says it is ready, runs one check with the fake agent, and exits on its own", async () => {
    const home = await runnerHome();
    await recordResult(home, { need: "runner", result: "yes-tested", reason: "a pass", at: "2026-10-01T12:00:00.000Z", agent: "fake-agent", agent_version: "9.9.9", test: "t7" });
    await startRecheck(home, () => new Date().toISOString());
    await until(async () => ((await readConfig(home, RECHECK_FILE)) as RecheckState | null)?.last !== undefined);
    await until(() => access(join(home, RECHECK_LOCK)).then(() => false, () => true));
    expect(((await readConfig(home, RECHECK_FILE)) as RecheckState).last).toMatchObject({ result: "pass" });
  }, 90_000);
});
