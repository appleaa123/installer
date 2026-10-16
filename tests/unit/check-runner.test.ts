import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runnerCheck } from "../../src/core/check-runner.js";
import { saveChannel } from "../../src/core/channels.js";
import { abilities, freshResult } from "../../src/core/checks.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Spec T7, plan review 4: the runner test passes only when the ping really arrived through MCP, under the hook. */
const AT = new Date().toISOString();
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());
const script = (calls: unknown[]) => vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({ calls, answer: { done: true } }));

describe("T7: TaskFollow's own runner as a home", () => {
  it("passes runner and tools when the agent's task really calls check.ping through MCP", async () => {
    const home = await runnerHome();
    script([{ tool: "mcp__installer__check_ping", input: "from-prompt" }]);
    const out = await runnerCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ test: "t7", passed: true });
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", AT)).toMatchObject({ result: "yes-tested", via: "mcp" });
    expect(await freshResult(home, "tools", "fake-agent", "9.9.9", AT)).toMatchObject({ result: "yes-tested" });
  }, 60_000);

  it("is not checked when the task never makes the call", async () => {
    const home = await runnerHome();
    script([]);
    const out = await runnerCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ passed: false });
    expect(await freshResult(home, "runner", "fake-agent", "9.9.9", AT)).toMatchObject({ result: "not-checked", reason: expect.stringContaining("did not make the test call") });
  }, 60_000);

  it("per workflow: reading email is not by construction when no email channel is connected", async () => {
    const home = await runnerHome();
    script([{ tool: "mcp__installer__check_ping", input: "from-skills" }]);
    const workflow = parseWorkflow({ workflow: "brief", version: 1, mode: "agentic", instructions: "Read the inbox and brief me.", tools: ["channel.inbox", "channel.notify"] }, "brief", DEFAULT_TOOLS);
    await runnerCheck(home, (await loadState(home)) ?? undefined, { now: () => AT, workflow });
    expect(await freshResult(home, "reads:email", "fake-agent", "9.9.9", AT, "brief")).toBeNull();
  }, 60_000);

  it("says plainly when the agent cannot be run unattended here", async () => {
    const home = await runnerHome();
    const state = await loadState(home);
    if (state?.runtime) await saveState(home, { ...state, runtime: { ...state.runtime, profile: "codex" } });
    const out = await runnerCheck(home, (await loadState(home)) ?? undefined, { now: () => AT });
    expect(out).toMatchObject({ passed: false });
    expect((await abilities(home)).find((entry) => entry.need === "runner")).toMatchObject({ result: "not-checked", reason: expect.stringContaining("its own runner is not a home") });
  });

  it("per workflow: the skill's word reaches the task only through the inlined skills", async () => {
    const home = await runnerHome();
    await saveChannel(home, { channel: "email", address: "me@example.com", verified_at: AT, imap: { host: "imap.example.com", port: 993, security: "ssl", user: "me@example.com" }, smtp: { host: "smtp.example.com", port: 465, security: "ssl", user: "me@example.com" } });
    script([{ tool: "mcp__installer__check_ping", input: "from-skills" }]);
    const workflow = parseWorkflow({ workflow: "brief", version: 1, mode: "agentic", instructions: "Read the inbox and brief me.", tools: ["channel.inbox", "channel.notify"] }, "brief", DEFAULT_TOOLS);
    const out = await runnerCheck(home, (await loadState(home)) ?? undefined, { now: () => AT, workflow });
    expect(out).toMatchObject({ passed: true });
    expect(await freshResult(home, "skills", "fake-agent", "9.9.9", AT, "brief")).toMatchObject({ result: "yes-tested" });
    expect(await freshResult(home, "reads:email", "fake-agent", "9.9.9", AT, "brief")).toMatchObject({ result: "yes-tested", reason: expect.stringContaining("by construction") });
  }, 60_000);
});
