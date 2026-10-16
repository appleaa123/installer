import { describe, expect, it } from "vitest";
import { parseSolution } from "../../src/core/solution.js";
import { buildReport, renderReport } from "../../src/core/report.js";
import type { InstallState, StepRecord } from "../../src/core/types.js";
import { FIXTURE_REF, basicSolution } from "../helpers/memory-deps.js";

const AT = "2026-01-01T00:00:00.000Z";
const done: StepRecord = { status: "done", at: AT };
const ALL = ["preflight.write-config", "preflight.check-config", "mode.shared-work", "mode.report-time", "brain.register", "channels.optional-extra", "report.final"];

function stateWith(records: Record<string, StepRecord>): InstallState {
  return { schema: 1, solution: { ref: FIXTURE_REF, id: "fixture-basic", version: "1.0.0" }, started_at: AT, steps: records };
}

const allDone = (overrides: Record<string, StepRecord> = {}): InstallState =>
  stateWith({ ...Object.fromEntries(ALL.map((id) => [id, done])), ...overrides });

describe("an install with no Skills Wiki (D126)", () => {
  const runtime = { profile: "claude-code", agent_version: "2.1.294", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true, c6_mcp: "not_probed" as const, support_level: 2 as const, tier: "compatible" as const, notes: [] };

  it("does not list the Skills Wiki connection as unchecked", () => {
    const report = buildReport(basicSolution(), { ...stateWith({}), runtime });
    expect(renderReport(report)).not.toContain("MCP not checked yet");
    expect(renderReport(report)).toContain("claude-code 2.1.294 — level 2 of 3");
  });

  it("still lists it when Skills Wiki is connected", () => {
    expect(renderReport(buildReport(basicSolution(), { ...stateWith({}), runtime, skillswiki: { url: "https://wiki.test/mcp" } }))).toContain("MCP not checked yet");
  });
});

describe("buildReport", () => {
  it("is in_progress with the current question under needs_you", () => {
    const report = buildReport(basicSolution(), stateWith({ "preflight.write-config": done, "preflight.check-config": done }));
    expect(report.overall).toBe("in_progress");
    expect(report.phase).toBe("MODE");
    expect(report.needs_you.map((item) => item.step_id)).toEqual(["mode.shared-work"]);
    expect(report.done).toBe(2);
    expect(report.total).toBe(7);
  });

  it("is blocked when a blocking step is blocked, with the resume instruction", () => {
    const blocked: StepRecord = { status: "blocked", at: AT, attempts: 3, hint: "config/agent-marker.txt not found" };
    const report = buildReport(basicSolution(), stateWith({ ...Object.fromEntries(ALL.slice(0, 4).map((id) => [id, done])), "brain.register": blocked }));
    expect(report.overall).toBe("blocked");
    expect(report.needs_you).toHaveLength(1);
    expect(report.needs_you[0]?.detail).toContain("taskfollow resume");
  });

  it("is ready_with_limits when only a non-blocking step is blocked", () => {
    const report = buildReport(basicSolution(), allDone({ "channels.optional-extra": { status: "blocked", at: AT, hint: "Extra channel not connected yet" } }));
    expect(report.overall).toBe("ready_with_limits");
    expect(report.limited).toEqual([{ step_id: "channels.optional-extra", title: "Connect an optional extra channel", detail: "Extra channel not connected yet" }]);
    expect(report.phase).toBeNull();
  });

  it("lists a failed current verify step once, with attempts and 'taskfollow resume'", () => {
    const failed: StepRecord = { status: "failed", at: AT, attempts: 2, hint: "Marker not there yet" };
    const solution = parseSolution({
      id: "retry",
      version: "1",
      steps: [{ step_id: "v", phase: "PREFLIGHT", type: "verify", title: "Check", why: "Needed.", blocking: true, verify: { check: "file_exists", args: { path: "x" } } }],
    });
    const report = buildReport(solution, stateWith({ v: failed }));
    expect(report.needs_you).toEqual([{ step_id: "v", title: "Check", detail: "Marker not there yet (failed 2 of 3 tries) → then run 'taskfollow resume'" }]);
  });

  it("names 'taskfollow verify <id>' for a failed current agent_action", () => {
    const failed: StepRecord = { status: "failed", at: AT, attempts: 1, hint: "config/agent-marker.txt not found" };
    const report = buildReport(basicSolution(), stateWith({ ...Object.fromEntries(ALL.slice(0, 4).map((id) => [id, done])), "brain.register": failed }));
    expect(report.needs_you).toHaveLength(1);
    expect(report.needs_you[0]?.detail).toBe("config/agent-marker.txt not found (failed 1 of 3 tries) → then run 'taskfollow verify brain.register'");
  });

  it("is ready when every step is done", () => {
    expect(buildReport(basicSolution(), allDone()).overall).toBe("ready");
  });
});

describe("renderReport", () => {
  it("renders the headline and sections", () => {
    const text = renderReport(buildReport(basicSolution(), allDone({ "channels.optional-extra": { status: "blocked", at: AT, hint: "Not connected" } })));
    expect(text).toContain("READY WITH LIMITS");
    expect(text).toContain("6 of 7 steps done");
    expect(text).toContain("Connect an optional extra channel — Not connected");
  });
});

describe("runtime line", () => {
  const runtime = {
    profile: "claude-code", agent_version: "2.1.294", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true,
    c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
  } as const;

  it("shows the agent and keeps a full runtime READY", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime, skillswiki: { url: "https://wiki.test/mcp" } });
    expect(report.overall).toBe("ready");
    expect(report.runtime_limits).toEqual([]);
    expect(renderReport(report).split("\n")[2]).toBe("🤖 Agent      claude-code 2.1.294 — level 2 of 3 (MCP not checked yet)");
  });

  it("turns a missing capability into READY WITH LIMITS", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c5_resume: false, support_level: 1 } });
    expect(report.overall).toBe("ready_with_limits");
    expect(report.runtime_limits).toEqual(["no session resume"]);
  });

  it("says fallbacks apply when no agent was recognised (Review Focus 2)", () => {
    const unknown = { ...runtime, profile: null, agent_version: null, c4_headless: false, c4_schema: false, c5_resume: false, support_level: 0, tier: "unknown" } as const;
    const report = buildReport(basicSolution(), { ...allDone(), runtime: unknown, skillswiki: { url: "https://wiki.test/mcp" } });
    expect(report.overall).toBe("ready_with_limits");
    expect(renderReport(report)).toContain("🤖 Agent      unknown agent — level 0 of 3 (no known agent profile; fallbacks apply, MCP not checked yet)");
  });

  it("counts a working MCP client as the third level with nothing missing", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c6_mcp: true, support_level: 3 } });
    expect(report.overall).toBe("ready");
    expect(renderReport(report).split("\n")[2]).toBe("🤖 Agent      claude-code 2.1.294 — level 3 of 3");
  });

  it("turns a failed MCP probe into READY WITH LIMITS that names the inlining fallback (D54)", () => {
    const report = buildReport(basicSolution(), { ...allDone(), runtime: { ...runtime, c6_mcp: false } });
    expect(report.overall).toBe("ready_with_limits");
    expect(report.runtime_limits).toEqual(["no MCP client; Skills Wiki content is inlined"]);
    expect(renderReport(report)).toContain("level 2 of 3 (no MCP client; Skills Wiki content is inlined)");
  });
  it("prints no agent line before the probe has run", () => {
    const report = buildReport(basicSolution(), allDone());
    expect(report.runtime).toBeNull();
    expect(renderReport(report)).not.toContain("Agent");
  });
});

describe("how the person is told, and where runs happen (9.12 item 3, 9.13 item 4)", () => {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const STARTER = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
  const answer = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
  const starterState = (records: Record<string, StepRecord>): InstallState => ({ schema: 1, solution: { ref: "file:starter.json", id: "starter", version: STARTER.version }, started_at: AT, steps: records });
  const SOLO = { "mode.who": answer("me"), "mode.always-on": answer("no"), "services.telegram": answer("none"), "services.email": answer("none") };
  const PUSH = { pushNote: "Claude Code Channels is a research preview: it needs --channels, an approved plugin and an open chat window", pushRead: "2026-10-16" };

  it("says level 1 in the agent's chat, and that speaking first was not checked, with the source", () => {
    const report = buildReport(STARTER, starterState(SOLO), PUSH);
    expect(report.told).toMatchObject({ level: 1, how: expect.stringContaining("the next time you talk to it") });
    expect(report.told.next_level).toContain("TaskFollow has not checked whether your agent can start a conversation");
    expect(report.told.next_level).toContain("read 2026-10-16");
    expect(report.told.next_level).toContain("taskfollow add telegram");
    expect(report.told.next_level).not.toMatch(/cannot start/);
    expect(renderReport(report)).toContain("💬 Told");
  });

  it("says 'not checked for this agent' when the agent's profile has no note", () => {
    expect(buildReport(STARTER, starterState(SOLO)).told.next_level).toContain("not checked for this agent");
  });

  it("says level 3 once a channel for the person is checked, and keeps approvals in the terminal for email", () => {
    const telegram = buildReport(STARTER, starterState({ ...SOLO, "services.telegram": answer("telegram"), "channels.telegram": { status: "done", at: AT } }), PUSH);
    expect(telegram.told).toMatchObject({ level: 3, how: expect.stringContaining("Telegram") });
    const email = buildReport(STARTER, starterState({ ...SOLO, "services.email": answer("email"), "channels.email": { status: "done", at: AT } }), PUSH);
    expect(email.told.how).toContain("Approval requests are not sent by email: they wait in your terminal, and your agent tells you about them at the start of each session.");
  });

  it("does not count WhatsApp, which reaches customers, as a way to tell the person", () => {
    const report = buildReport(STARTER, starterState({ ...SOLO, "services.whatsapp": answer("whatsapp"), "channels.whatsapp": { status: "done", at: AT } }), PUSH);
    expect(report.told.level).toBe(1);
  });

  it("says where runs happen, honestly for 'yes', and nothing for an install that was never asked", () => {
    expect(buildReport(STARTER, starterState(SOLO)).runs).toContain("on this computer while it is on and awake");
    const yes = buildReport(STARTER, starterState({ ...SOLO, "mode.always-on": answer("yes") })).runs ?? "";
    expect(yes).toContain("Until a computer that stays on is set up");
    expect(yes).toContain("your own Claude plan");
    expect(buildReport(STARTER, starterState({ "mode.who": answer("me") })).runs).toBeUndefined();
  });

  it("does not lower the overall verdict for an install with no channel", () => {
    expect(buildReport(STARTER, starterState(SOLO)).runtime_limits).toEqual([]);
  });
});
