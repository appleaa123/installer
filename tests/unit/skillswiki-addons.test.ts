import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { currentStep, submit } from "../../src/core/engine.js";
import { InputError, validateInput } from "../../src/core/inputs.js";
import { addService } from "../../src/core/services.js";
import { asksSkillswikiUrl, hostedMcpNames, setSkillswikiUrlAction, usesSkillswiki } from "../../src/core/skillswiki.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import type { InstallState, StepRecord } from "../../src/core/types.js";
import { visibleSteps } from "../../src/core/visibility.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** D178: hosted and local Skills Wiki are optional add-ons of the starter; saying no to both is the 0.1.1 install. */
const STARTER = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
const AT = "2026-10-20T12:00:00.000Z";
const done = (value: unknown): StepRecord => ({ status: "done", at: AT, by: "human", value });
const state = (answers: Record<string, unknown>, extra: Partial<InstallState> = {}): InstallState => ({
  schema: 1, solution: { ref: "file:starter.json", id: STARTER.id, version: STARTER.version }, started_at: AT,
  steps: Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, done(value)])), ...extra,
});
const SOLO = { "mode.purpose": "install", "mode.who": "me", "mode.name": "Owner", "mode.always-on": "no", "services.records": "none", "services.telegram": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" };
const visible = (answers: Record<string, unknown>) => visibleSteps(STARTER, state(answers)).map((step) => step.step_id);
const brainSteps = (ids: string[]) => ids.filter((id) => id.startsWith("brain.") || id.startsWith("skills."));
const URL = "https://skills-portal.skills-library.workers.dev/client-1/mcp";

describe("hosted Skills Wiki in the starter (D178)", () => {
  it("asks about it with the paid and account warning, default no, only for an install", () => {
    const question = STARTER.steps.find((step) => step.step_id === "services.skillswiki");
    expect(question?.input).toEqual({ kind: "choice", options: ["skillswiki", "none"] });
    expect(question?.default).toBe("none");
    expect(question?.why).toContain("paid service");
    expect(question?.why).toContain("Skills Wiki account");
    expect(visible({ "mode.purpose": "consult" })).not.toContain("services.skillswiki");
  });

  it("has no Skills Wiki step at all when the person says no", () => {
    expect(brainSteps(visible({ ...SOLO, "services.skillswiki": "none" }))).toEqual([]);
  });

  it("asks for the address, keeps it, then takes the key, registers, checks the combo and probes when the person says yes", () => {
    expect(brainSteps(visible({ ...SOLO, "services.skillswiki": "skillswiki" }))).toEqual(["brain.url", "brain.url-set", "brain.key", "brain.register", "brain.combo", "brain.probe-mcp"]);
  });

  it("starts without --url: the address is asked during the install", () => {
    expect(usesSkillswiki(STARTER)).toBe(true);
    expect(asksSkillswikiUrl(STARTER)).toBe(true);
  });

  it("`taskfollow add skillswiki` after a no comes next with the address question", async () => {
    const finished = Object.fromEntries(visibleSteps(STARTER, state({ ...SOLO, "services.skillswiki": "none" })).map((step) => [step.step_id, (SOLO as Record<string, unknown>)[step.step_id] ?? (step.step_id === "services.skillswiki" ? "none" : "done")]));
    const { deps } = memoryDeps(await makeTempHome(), STARTER);
    const added = await addService(deps, state(finished), "skillswiki");
    expect(added.state.steps["services.skillswiki"]?.value).toBe("skillswiki");
    expect(currentStep(STARTER, added.state)?.step_id).toBe("brain.url");
  });
});

describe("the Skills Wiki address (D178)", () => {
  it("accepts an https address and refuses anything else at submit", () => {
    expect(validateInput({ kind: "url" }, ` ${URL} `)).toBe(URL);
    expect(validateInput({ kind: "url" }, "http://127.0.0.1:4000/mcp")).toBe("http://127.0.0.1:4000/mcp");
    for (const bad of ["http://wiki.test/mcp", "wiki.test/mcp", 42]) expect(() => validateInput({ kind: "url" }, bad)).toThrow(InputError);
  });

  it("refuses a bad address when it is submitted, so the person can answer again", async () => {
    const { deps } = memoryDeps(await makeTempHome(), STARTER);
    const asked = state({ ...SOLO, "services.skillswiki": "skillswiki" });
    const finished = Object.fromEntries(visibleSteps(STARTER, asked).filter((step) => STARTER.steps.indexOf(step) < STARTER.steps.findIndex((s) => s.step_id === "brain.url")).map((step) => [step.step_id, asked.steps[step.step_id]?.value ?? "done"]));
    await expect(submit(deps, state(finished), "brain.url", { kind: "value", value: "http://wiki.test/mcp" })).rejects.toThrow("https://");
  });

  it("keeps the answered address where `start --url` keeps it", () => {
    expect(setSkillswikiUrlAction({ url: "brain.url" }, state({ "brain.url": URL }))).toEqual({ skillswiki: { url: URL } });
  });

  it("keeps the address given to `start --url`", () => {
    expect(setSkillswikiUrlAction({ url: "brain.url" }, state({ "brain.url": URL }, { skillswiki: { url: "https://other.test/mcp" } }))).toEqual({});
  });

  it("fails plainly while the address is not answered", () => {
    expect(() => setSkillswikiUrlAction({ url: "brain.url" }, state({}))).toThrow("not answered yet");
  });

  it("refuses a solution whose set_skillswiki_url does not read an earlier address question", () => {
    const raw = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { steps: { step_id: string; input?: unknown }[] };
    const broken = { ...raw, steps: raw.steps.map((step) => (step.step_id === "brain.url" ? { ...step, input: { kind: "text" } } : step)) };
    expect(() => parseSolution(broken)).toThrow(SolutionError);
  });
});

describe("hosted Skills Wiki's agent registration (D178)", () => {
  it("is named skillswiki-hosted, so local Skills Wiki's own 'skillswiki' server is never replaced", () => {
    expect(hostedMcpNames(state({ "services.skills": "skills" }))).toEqual(["skillswiki-hosted"]);
  });

  it("also removes the old 'skillswiki' name while local Skills Wiki is not on", () => {
    expect(hostedMcpNames(state({}))).toEqual(["skillswiki-hosted", "skillswiki"]);
  });
});


describe("local Skills Wiki in the starter (D178)", () => {
  const finishedWith = (answers: Record<string, unknown>) => Object.fromEntries(visibleSteps(STARTER, state(answers)).map((step) => [step.step_id, answers[step.step_id] ?? "done"]));

  it("asks about it with the move warning, default no, only for an install", () => {
    const question = STARTER.steps.find((step) => step.step_id === "services.skills");
    expect(question?.input).toEqual({ kind: "choice", options: ["skills", "none"] });
    expect(question?.default).toBe("none");
    expect(question?.why).toContain("will move into the Skills Wiki library");
    expect(question?.why).toContain("skillswiki release --all");
    expect(visible({ "mode.purpose": "consult" })).not.toContain("services.skills");
  });

  it("installs it, without stopping the install when that fails, only when the person says yes", () => {
    expect(brainSteps(visible({ ...SOLO, "services.skills": "none" }))).toEqual([]);
    expect(brainSteps(visible({ ...SOLO, "services.skills": "skills" }))).toEqual(["skills.install"]);
    expect(STARTER.steps.find((step) => step.step_id === "skills.install")).toMatchObject({ blocking: false, auto: { action: "install_skillswiki" } });
  });

  it("both add-ons together: local first, then hosted", () => {
    expect(brainSteps(visible({ ...SOLO, "services.skills": "skills", "services.skillswiki": "skillswiki" }))).toEqual(["skills.install", "brain.url", "brain.url-set", "brain.key", "brain.register", "brain.combo", "brain.probe-mcp"]);
  });

  it("`taskfollow add skills` says the move warning and changes nothing until the person agreed", async () => {
    const before = state(finishedWith({ ...SOLO, "services.skills": "none", "services.skillswiki": "none" }));
    const { deps, saved } = memoryDeps(await makeTempHome(), STARTER);
    await expect(addService(deps, before, "skills")).rejects.toThrow("taskfollow add skills --confirm-move");
    expect(saved).toEqual([]);
    const added = await addService(deps, before, "skills", true);
    expect(added.state.steps["services.skills"]?.value).toBe("skills");
  });

  it("the Skills Wiki starter offers local Skills Wiki too, beside its hosted steps", () => {
    const hosted = parseSolution(JSON.parse(readFileSync("solutions/starter-skillswiki.json", "utf8")));
    expect(hosted.steps.find((step) => step.step_id === "services.skills")?.default).toBe("none");
    expect(hosted.steps.some((step) => step.step_id === "services.skillswiki")).toBe(false);
    expect(hosted.steps.find((step) => step.step_id === "skills.install")?.when).toEqual({ step: "services.skills", equals: "skills" });
  });
});

describe("INSTALL.md on the Skills Wiki add-ons (D178)", () => {
  const section = (() => {
    const doc = readFileSync("INSTALL.md", "utf8");
    return doc.slice(doc.indexOf("## 11."), doc.indexOf("## Operator rules"));
  })();

  it("tells the agent to give the move warning and the cost warning before a yes", () => {
    expect(section).toContain("their installed skills move into the Skills Wiki library (`~/.skillswiki`)");
    expect(section).toContain("it costs money and needs an account");
  });

  it("names the commands to add each one later, to get unblocked and to remove local Skills Wiki", () => {
    for (const command of ["taskfollow add skillswiki", "taskfollow add skills --confirm-move", "taskfollow resume", "taskfollow uninstall --remove-skillswiki"]) expect(section).toContain(command);
  });
});
