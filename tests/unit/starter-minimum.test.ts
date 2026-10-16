import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addableOptions } from "../../src/core/services.js";
import { parseSolution } from "../../src/core/solution.js";
import type { InstallState, StepRecord, StepWhen } from "../../src/core/types.js";
import { visibleSteps, whenHolds } from "../../src/core/visibility.js";

/** 9.12 item 3: a person on their own installs with no channel; Telegram, email and Slack only when chosen. */
const STARTER = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
const AT = "2026-10-16T12:00:00.000Z";
const done = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
const state = (answers: Record<string, unknown>): InstallState => ({
  schema: 1, solution: { ref: "file:starter.json", id: STARTER.id, version: STARTER.version }, started_at: AT,
  steps: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, done(value)])),
});
const SOLO = { "mode.purpose": "install", "mode.who": "me", "mode.name": "Owner", "mode.always-on": "no", "services.records": "none", "services.telegram": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };
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
  const TEAM = { "mode.purpose": "install", "mode.who": "team", "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner", "services.records": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };

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
    const TEAM = { "mode.purpose": "install", "mode.who": "team", "services.records": "none" };
    await expect(addService({ solution: STARTER } as never, state(TEAM), "telegram")).rejects.toThrow("already part of this setup");
  });
});

describe("taskfollow add telegram for a person on their own (PR #45 review)", () => {
  it("asks to finish the install first while it is not known yet whether this is a team", async () => {
    const { addService } = await import("../../src/core/services.js");
    await expect(addService({ solution: STARTER } as never, state({ "services.records": "none" }), "telegram")).rejects.toThrow("Finish the install first");
  });

  it("after email was set up, comes next with the Telegram key, then the gateway restart that makes the running gateway read Telegram", async () => {
    const { currentStep } = await import("../../src/core/engine.js");
    const emailInstall = { ...SOLO, "services.email": "email" };
    const finished = Object.fromEntries(visibleSteps(STARTER, state(emailInstall)).map((step) => [step.step_id, (emailInstall as Record<string, unknown>)[step.step_id] ?? "done"]));
    const added = state({ ...finished, "services.telegram": "telegram" });
    expect(currentStep(STARTER, added)?.step_id).toBe("channels.telegram-key");
    const remaining = visibleSteps(STARTER, added).map((step) => step.step_id).filter((id) => !(id in finished));
    expect(remaining).toEqual(["channels.telegram-key", "channels.telegram", "channels.telegram-gateway"]);
  });
});

describe("the starter's suggested workflows", () => {
  /** An agentic suggestion's instructions, or each agent step's of a typed one (item 5's shapes are typed). */
  const instructionsOf = (flow: Record<string, unknown>): string[] => (Array.isArray(flow.steps)
    ? (flow.steps as { agent?: { instructions?: string } }[]).flatMap((step) => (step.agent?.instructions === undefined ? [] : [step.agent.instructions]))
    : [String(flow.instructions)]);

  it("end with their result when nobody joined a channel", () => {
    for (const flow of STARTER.workflows ?? []) {
      const [first] = instructionsOf(flow);
      expect(first).toContain("finish with the note as your summary");
    }
  });

  it("the starter suggests both inbox shapes when email was chosen or in a consultation, not otherwise (item 5)", () => {
    const offered = (answers: Record<string, unknown>) => (STARTER.workflows ?? []).filter((flow) => whenHolds(flow.when as StepWhen | undefined, state(answers))).map((flow) => flow.workflow);
    expect(offered({ ...SOLO, "services.email": "email" })).toEqual(expect.arrayContaining(["inbox-triage", "inbox-triage-replies"]));
    expect(offered({ "mode.purpose": "consult" })).toEqual(expect.arrayContaining(["inbox-triage", "inbox-triage-replies"]));
    expect(offered(SOLO)).not.toContain("inbox-triage");
    expect(offered(SOLO)).not.toContain("inbox-triage-replies");
    expect(STARTER.version).toBe("2.1.0");
  });

  it("inbox-triage-replies makes its list before any reply, and only the reply step can send (item 5)", () => {
    const replies = (STARTER.workflows ?? []).find((flow) => flow.workflow === "inbox-triage-replies") as { steps: { id: string; tool?: string; args?: Record<string, unknown>; agent?: { tools: string[] } }[] };
    expect(replies.steps.map((step) => step.id)).toEqual(["mail", "triage", "reply"]);
    expect(replies.steps[0]).toMatchObject({ tool: "channel.inbox", args: { channel: "email", limit: 50, after: "last-run" } });
    expect(replies.steps[1]?.agent?.tools).not.toContain("channel.send");
    expect(replies.steps[2]?.agent?.tools).toEqual(["channel.send"]);
    const triage = (STARTER.workflows ?? []).find((flow) => flow.workflow === "inbox-triage") as { steps: { agent?: { tools: string[] } }[]; trigger: unknown };
    expect(triage.steps.flatMap((step) => step.agent?.tools ?? [])).not.toContain("channel.send");
    expect(triage.trigger).toEqual({ cron: "0 8 * * *", tz: "local" });
  });

describe("the consult path (item 7 Task 8, D163)", () => {
  it("asks only the consultation's steps after the first question", () => {
    expect(visible({ "mode.purpose": "consult" })).toEqual(["preflight.probe", "preflight.tools", "mode.purpose", "consult.names", "consult.choose", "consult.report", "consult.cleanup", "report.final"]);
  });

  it("keeps the install path as it was, without the consultation's steps", () => {
    const ids = visible({ ...SOLO });
    expect(ids).toContain("workflows.choose");
    expect(ids.filter((id) => id.startsWith("consult."))).toEqual([]);
  });

  it("switches only a consultation to an install", async () => {
    const { addService } = await import("../../src/core/services.js");
    await expect(addService({ solution: STARTER } as never, state({ ...SOLO }), "install")).rejects.toThrow("not a consultation");
  });
});

});
