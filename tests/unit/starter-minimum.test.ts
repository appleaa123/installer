import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addableOptions } from "../../src/core/services.js";
import { parseSolution } from "../../src/core/solution.js";
import type { InstallState, StepRecord } from "../../src/core/types.js";
import { visibleSteps } from "../../src/core/visibility.js";

/** 9.12 item 3: a person on their own installs with no channel; Telegram, email and Slack only when chosen. */
const STARTER = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
const AT = "2026-10-16T12:00:00.000Z";
const done = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
const state = (answers: Record<string, unknown>): InstallState => ({
  schema: 1, solution: { ref: "file:starter.json", id: STARTER.id, version: STARTER.version }, started_at: AT,
  steps: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, done(value)])),
});
const SOLO = { "mode.who": "me", "mode.name": "Owner", "mode.always-on": "no", "services.records": "none", "services.telegram": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };
const visible = (answers: Record<string, unknown>) => visibleSteps(STARTER, state(answers)).map((step) => step.step_id);
const channelSteps = (ids: string[]) => ids.filter((id) => id.startsWith("channels.") || id === "activate.gateway");

describe("the starter for a person on their own (9.12 item 3)", () => {
  it("has no channel step and no gateway when nothing was chosen, and asks where runs happen", () => {
    const ids = visible(SOLO);
    expect(channelSteps(ids)).toEqual([]);
    expect(ids).toContain("services.telegram");
    expect(ids).toContain("mode.always-on");
  });

  it("brings in Telegram, its gateway restart, the gateway and the join step when Telegram was chosen", () => {
    expect(channelSteps(visible({ ...SOLO, "services.telegram": "telegram" }))).toEqual(["channels.telegram-key", "channels.telegram", "channels.telegram-gateway", "channels.gateway", "channels.join-solo", "activate.gateway"]);
  });

  it("brings in email, the gateway and the join step, but no Telegram, when only email was chosen", () => {
    expect(channelSteps(visible({ ...SOLO, "services.email": "email" }))).toEqual(["channels.email-key", "channels.email", "channels.email-gateway", "channels.gateway", "channels.join-solo", "activate.gateway"]);
  });

  it("joins a person who chose only Slack", () => {
    expect(channelSteps(visible({ ...SOLO, "services.slack": "slack" }))).toContain("channels.join-solo");
  });

  it("offers Telegram to add later", () => {
    expect(addableOptions(STARTER, state(SOLO))).toContain("telegram");
  });

  it("gives the person's own runs the always-on answer", () => {
    const derive = STARTER.steps.find((step) => step.step_id === "mode.derive-solo");
    expect(derive?.auto?.args).toMatchObject({ always_on: "mode.always-on" });
  });
});

describe("the starter for a team (unchanged)", () => {
  const TEAM = { "mode.who": "team", "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner", "services.records": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };

  it("still has Telegram, the gateway and the team join step, and is never asked about Telegram", () => {
    const ids = visible(TEAM);
    expect(ids).not.toContain("services.telegram");
    expect(channelSteps(ids)).toEqual(["channels.telegram-key", "channels.telegram", "channels.gateway", "channels.join", "activate.gateway"]);
  });

  it("never asks a team that also chose email or Slack to link itself as a person on their own (PR #45 review)", () => {
    const ids = channelSteps(visible({ ...TEAM, "services.email": "email", "services.slack": "slack" }));
    expect(ids).toContain("channels.join");
    expect(ids).not.toContain("channels.join-solo");
  });
});

describe("taskfollow add telegram for a team", () => {
  it("says Telegram is already part of the setup instead of asking to finish the install", async () => {
    const { addService } = await import("../../src/core/services.js");
    const TEAM = { "mode.who": "team", "services.records": "none" };
    await expect(addService({ solution: STARTER } as never, state(TEAM), "telegram")).rejects.toThrow("already part of this setup");
  });
});

describe("the starter's suggested workflows", () => {
  it("end with their result when nobody joined a channel", () => {
    for (const flow of STARTER.workflows ?? []) expect(String(flow.instructions)).toContain("finish with the note as your summary");
  });
});
