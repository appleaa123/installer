import { describe, expect, it } from "vitest";
import { saveChannel } from "../../src/core/channels.js";
import { dataFlow, fieldsByTag, operationsView, renderOperations } from "../../src/core/data-flow.js";
import { saveSource, writeConfig } from "../../src/core/data-source.js";
import { runDoctor } from "../../src/core/doctor.js";
import { saveReadiness } from "../../src/core/host.js";
import { MODEL_CONFIG } from "../../src/core/model.js";
import { setPaused } from "../../src/core/pause.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadState, saveState } from "../../src/core/state.js";
import type { InstallState } from "../../src/core/types.js";
import { FAKE_RUNTIME, runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
/** A contract with one field of each tag, and one untagged. */
const SOLUTION = {
  id: "fixture-flow", version: "1.0.0",
  data_contract: { entities: { contact: { key: "email", fields: {
    name: { type: "text", tags: ["personal"], required: true }, email: { type: "email", tags: ["personal"] }, notes: { type: "text" },
    balance: { type: "money", tags: ["financial"] }, origin: { type: "text", tags: ["protected_ground"] },
  } } } },
  steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }],
};

async function flowHome(extra: Partial<InstallState> = {}): Promise<{ home: string; state: InstallState }> {
  const home = await runnerHome();
  await writePinnedSolution(home, JSON.stringify(SOLUTION));
  const state = { ...((await loadState(home)) as InstallState), ...extra };
  await saveState(home, state);
  return { home, state };
}

describe("the data-flow summary (§14.6, D106)", () => {
  it("names each outside party and the tagged fields it receives; the model never gets protected_ground fields", async () => {
    const { home, state } = await flowHome({ skillswiki: { url: "https://skills.example/mcp" } });
    await saveSource(home, { entity: "contact", connector: { id: "google-sheets", version: "1", sha256: "pinned" }, spreadsheet_id: "sheet-1" });
    await saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: AT });
    const rows = await dataFlow(home, state);
    expect(rows.map((row) => row.party)).toEqual(["Model vendor", "google-sheets", "telegram", "Skills Wiki", "Support (only when you send it)"]);
    expect(rows[0]).toMatchObject({ via: "your agent (fake-agent) in headless calls with every tool off", receives: "what judge and agent steps are given: personal: contact.name, contact.email; untagged: contact.notes; financial: contact.balance" });
    expect(rows[0]?.receives).not.toContain("contact.origin");
    expect(rows[1]?.receives).toContain("protected_ground: contact.origin");
    expect(rows[3]).toMatchObject({ never: "business records, secrets, inbound messages, the audit" });
  });

  it("names the direct model when the agent cannot answer headless, and no model when neither is set up", async () => {
    const { home, state } = await flowHome({ runtime: { ...FAKE_RUNTIME, c4_headless: false } });
    expect((await dataFlow(home, state)).map((row) => row.party)).toEqual(["Support (only when you send it)"]);
    await writeConfig(home, MODEL_CONFIG, { provider: "anthropic", model: "a-model", max_tokens: 4096 });
    expect((await dataFlow(home, state))[0]).toMatchObject({ party: "Model vendor", via: "the direct model API (anthropic, a-model) with your own key" });
    expect(fieldsByTag(null, null)).toBe("no record fields");
  });

  it("adds the pause, the last doctor run, the readiness score and the data flow to the report", async () => {
    const { home, state } = await flowHome();
    expect(renderOperations(await operationsView(home, state))).toEqual(expect.arrayContaining(["🩺 Doctor     never run: run 'taskfollow doctor'", "🖥️ Host       not checked yet: run 'taskfollow host'", "🔀 Data flow"]));
    await setPaused(home, true, { name: "agent", actor: "agent", via: "cli" }, AT);
    const doctor = await runDoctor(home, { now: () => AT });
    await saveReadiness(home, { mode: "personal", applies: false, score: "3/5", checked_at: AT, checks: [] });
    const view = await operationsView(home, state);
    expect(view).toMatchObject({ paused: { paused: true }, doctor: { status: doctor.status, checked_at: AT }, readiness: { score: "3/5", applies: false } });
    const lines = renderOperations(view);
    expect(lines[0]).toBe("⏸️ Paused     since 2026-10-08T12:00:00.000Z by agent: nothing is sent, no run starts ('taskfollow unpause' in a person's terminal)");
    expect(lines).toContain("🖥️ Host       readiness 3/5 (Personal mode: for information only)");
    expect(lines.at(-1)).toContain("   Support (only when you send it) — 'taskfollow support bundle'");
  });
});
