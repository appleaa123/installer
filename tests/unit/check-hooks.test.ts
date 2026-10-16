import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hooksCheck } from "../../src/core/check-runner.js";
import { freshResult, loadChallenge } from "../../src/core/checks.js";
import { loadState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 7a Task 5 (spec 5.2 T11, review B4): the hook must stop a call the step does not allow; three honest outcomes. */
const AT = new Date().toISOString();
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());
const script = (calls: unknown[]) => vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls, answer: { done: true } }));

describe("T11: hooks that can block a call", () => {
  it("is yes, tested when the hook refuses the call it was not allowed, and nothing reached TaskFollow", async () => {
    const home = await runnerHome();
    script([{ tool: "mcp__installer__check_ping", input: "from-prompt" }]);
    const out = await hooksCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ test: "t11", passed: true });
    expect(await freshResult(home, "hooks", "fake-agent", "9.9.9", AT)).toMatchObject({ result: "yes-tested", reason: expect.stringContaining("stopped") });
  }, 60_000);

  it("is no, tested when the call went through: the hook did not stop it (review B4)", async () => {
    const home = await runnerHome();
    vi.stubEnv("FAKE_AGENT_SKIP_HOOKS", "1");
    script([{ tool: "mcp__installer__check_ping", input: "from-prompt" }]);
    const out = await hooksCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ passed: false });
    expect(await freshResult(home, "hooks", "fake-agent", "9.9.9", AT)).toMatchObject({ result: "no-tested" });
  }, 60_000);

  it("is not checked when the agent never tried the call", async () => {
    const home = await runnerHome();
    script([]);
    const out = await hooksCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ passed: false });
    const result = await freshResult(home, "hooks", "fake-agent", "9.9.9", AT);
    expect(result).toMatchObject({ result: "not-checked" });
    expect((await loadChallenge(home, result?.challenge ?? ""))?.status).not.toBe("open");
  }, 60_000);
});
