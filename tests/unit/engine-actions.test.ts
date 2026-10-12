import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineError, advance, initialState, resume, start, submit, verifyStep } from "../../src/core/engine.js";
import { InputError } from "../../src/core/inputs.js";
import { buildReport } from "../../src/core/report.js";
import { parseSolution } from "../../src/core/solution.js";
import { FIXTURE_REF, basicSolution, memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

async function atBrainStep() {
  const home = await makeTempHome();
  const ctx = memoryDeps(home, basicSolution());
  const started = await start(ctx.deps, null, FIXTURE_REF);
  const one = await submit(ctx.deps, started.state, "mode.shared-work", { kind: "value", value: "yes" });
  const two = await submit(ctx.deps, one.state, "mode.report-time", { kind: "value", value: "09:00" });
  return { home, ...ctx, ...two };
}

async function touch(home: string, path: string): Promise<void> {
  await mkdir(join(home, "config"), { recursive: true });
  await writeFile(join(home, path), "ok\n", "utf8");
}

describe("submit", () => {
  it("records a valid answer and moves to the next step", async () => {
    const { state, result } = await atBrainStep();
    expect(state.steps["mode.shared-work"]).toMatchObject({ status: "done", by: "human", value: "yes" });
    expect(result).toMatchObject({ status: "step", view: { step: { step_id: "brain.register", type: "agent_action" } } });
  });

  it("rejects an invalid answer without saving", async () => {
    const home = await makeTempHome();
    const { deps, saved } = memoryDeps(home, basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF);
    const count = saved.length;
    await expect(submit(deps, state, "mode.shared-work", { kind: "value", value: "maybe" })).rejects.toThrow(InputError);
    expect(saved).toHaveLength(count);
  });

  it("rejects a step that is not current, naming the current one (Review Focus 2)", async () => {
    const home = await makeTempHome();
    const { deps, saved } = memoryDeps(home, basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF);
    const count = saved.length;
    await expect(submit(deps, state, "mode.report-time", { kind: "value", value: "09:00" })).rejects.toThrow(/current step is 'mode.shared-work'/);
    await expect(submit(deps, state, "no.such.step", { kind: "done" })).rejects.toThrow(/Unknown step/);
    await expect(verifyStep(deps, state, "brain.register")).rejects.toThrow(/current step is 'mode.shared-work'/);
    expect(saved).toHaveLength(count);
  });

  it("refuses to submit an agent_action and points to verify", async () => {
    const { deps, state } = await atBrainStep();
    await expect(submit(deps, state, "brain.register", { kind: "done" })).rejects.toThrow(/installer verify brain.register/);
  });

  it("never completes a secret step through submit (R4)", async () => {
    const home = await makeTempHome();
    const solution = parseSolution({
      id: "secret",
      version: "1",
      steps: [{ step_id: "s", phase: "BRAIN", type: "human_action", title: "Enter key", why: "Needed.", blocking: true, input: { kind: "secret" } }],
    });
    const { deps } = memoryDeps(home, solution);
    const { state } = await start(deps, null, "file:/s.json");
    await expect(submit(deps, state, "s", { kind: "done" })).rejects.toThrow(/local browser page/);
    await expect(submit(deps, state, "s", { kind: "value", value: "sk-123" })).rejects.toThrow(EngineError);
  });
});

describe("verifyStep and resume", () => {
  it("fails twice, then blocks on the third failure", async () => {
    const { deps, state } = await atBrainStep();
    const first = await verifyStep(deps, state, "brain.register");
    expect(first.result).toEqual({ status: "failed", hint: "config/agent-marker.txt not found", retry: true });
    const second = await verifyStep(deps, first.state, "brain.register");
    const third = await verifyStep(deps, second.state, "brain.register");
    expect(third.result).toMatchObject({ status: "blocked", retry: false });
    expect(third.next).toMatchObject({ status: "blocked", view: { attempts: 3 } });
  });

  it("returns the same blocked step on repeated next calls without writing (Review Focus 4)", async () => {
    const ctx = await atBrainStep();
    let state = ctx.state;
    for (let i = 0; i < 3; i += 1) state = (await verifyStep(ctx.deps, state, "brain.register")).state;
    const count = ctx.saved.length;
    const a = await advance(ctx.deps, state);
    const b = await advance(ctx.deps, a.state);
    expect(b.result).toEqual(a.result);
    expect(a.result).toMatchObject({ status: "blocked" });
    expect(ctx.saved).toHaveLength(count);
    await expect(verifyStep(ctx.deps, state, "brain.register")).rejects.toThrow(/run 'installer resume' first/);
  });

  it("resume resets blocked steps so a fixed problem can pass", async () => {
    const ctx = await atBrainStep();
    let state = ctx.state;
    for (let i = 0; i < 3; i += 1) state = (await verifyStep(ctx.deps, state, "brain.register")).state;
    const resumed = await resume(ctx.deps, state);
    expect(resumed.state.steps["brain.register"]).toMatchObject({ status: "pending", attempts: 0 });
    await touch(ctx.home, "config/agent-marker.txt");
    const passed = await verifyStep(ctx.deps, resumed.state, "brain.register");
    expect(passed.result).toEqual({ status: "passed" });
    expect(passed.state.steps["brain.register"]).toMatchObject({ status: "done", by: "agent" });
  });

  it("passes over a blocked non-blocking step and completes", async () => {
    const ctx = await atBrainStep();
    await touch(ctx.home, "config/agent-marker.txt");
    let state = (await verifyStep(ctx.deps, ctx.state, "brain.register")).state;
    let last;
    for (let i = 0; i < 3; i += 1) {
      last = await verifyStep(ctx.deps, state, "channels.optional-extra");
      state = last.state;
    }
    expect(last?.next).toEqual({ status: "complete" });
    expect(state.steps["channels.optional-extra"]?.status).toBe("blocked");
    expect(state.steps["report.final"]?.status).toBe("done");
  });

  it("resume reopens a given-up optional step, so the report is in progress again", async () => {
    const ctx = await atBrainStep();
    await touch(ctx.home, "config/agent-marker.txt");
    let state = (await verifyStep(ctx.deps, ctx.state, "brain.register")).state;
    for (let i = 0; i < 3; i += 1) state = (await verifyStep(ctx.deps, state, "channels.optional-extra")).state;
    expect(buildReport(ctx.deps.solution, state).overall).toBe("ready_with_limits");
    const resumed = await resume(ctx.deps, state);
    expect(resumed.result).toMatchObject({ status: "step", view: { step: { step_id: "channels.optional-extra" }, attempts: 0 } });
    expect(buildReport(ctx.deps.solution, resumed.state).overall).toBe("in_progress");
  });

  it("completes a human_action without a check through --done", async () => {
    const home = await makeTempHome();
    const solution = parseSolution({
      id: "done",
      version: "1",
      steps: [{ step_id: "h", phase: "DATA", type: "human_action", title: "Open the sheet", why: "Needed.", blocking: true }],
    });
    const { deps } = memoryDeps(home, solution);
    const { state } = await start(deps, null, "file:/d.json");
    await expect(submit(deps, state, "h", { kind: "done" })).resolves.toMatchObject({ result: { status: "complete" } });
  });
});

describe("unknown step ids", () => {
  it("are rejected before any pending engine step runs", async () => {
    const home = await makeTempHome();
    const solution = parseSolution({
      id: "pending-auto",
      version: "1",
      steps: [
        { step_id: "a", phase: "PREFLIGHT", type: "auto", title: "Auto", why: "Needed.", blocking: true, auto: { action: "noop" } },
        { step_id: "h", phase: "PREFLIGHT", type: "human_action", title: "Human", why: "Needed.", blocking: true },
      ],
    });
    const { deps, saved, events } = memoryDeps(home, solution);
    const state = initialState("file:/p.json", solution, "2026-01-01T00:00:00.000Z");
    await expect(submit(deps, state, "no.such.step", { kind: "done" })).rejects.toThrow(/Unknown step/);
    await expect(verifyStep(deps, state, "no.such.step")).rejects.toThrow(/Unknown step/);
    expect(saved).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("retry command in step views", () => {
  it("names installer verify for a failed agent_action step", async () => {
    const { deps, state } = await atBrainStep();
    const failed = await verifyStep(deps, state, "brain.register");
    const { result } = await advance(deps, failed.state);
    expect(result).toMatchObject({ status: "step", view: { status: "failed", resume: "installer verify brain.register" } });
  });

  it("keeps installer resume for a failed verify-type step", async () => {
    const home = await makeTempHome();
    const solution = parseSolution({
      id: "retry",
      version: "1",
      steps: [{ step_id: "v", phase: "PREFLIGHT", type: "verify", title: "Check", why: "Needed.", blocking: true, verify: { check: "file_exists", args: { path: "config/none.txt" } } }],
    });
    const { deps } = memoryDeps(home, solution);
    const { result } = await start(deps, null, "file:/r.json");
    expect(result).toMatchObject({ status: "step", view: { status: "failed", resume: "installer resume" } });
  });
});

describe("resume of a failed verify step", () => {
  const retrySolution = () =>
    parseSolution({
      id: "retry",
      version: "1",
      steps: [
        {
          step_id: "v",
          phase: "PREFLIGHT",
          type: "verify",
          title: "Check the marker",
          why: "Needed.",
          blocking: true,
          verify: { check: "file_exists", args: { path: "config/late-marker.txt", hint: "Marker not there yet" } },
        },
      ],
    });

  it("re-runs a failed verify step with attempts preserved", async () => {
    const home = await makeTempHome();
    const { deps } = memoryDeps(home, retrySolution());
    const { state } = await start(deps, null, "file:/r.json");
    expect(state.steps.v).toMatchObject({ status: "failed", attempts: 1 });
    const resumed = await resume(deps, state);
    expect(resumed.state.steps.v).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("fail, resume, fail, resume, third failure blocks", async () => {
    const home = await makeTempHome();
    const { deps } = memoryDeps(home, retrySolution());
    const { state } = await start(deps, null, "file:/r.json");
    const second = await resume(deps, state);
    expect(second.result).toMatchObject({ status: "step" });
    const third = await resume(deps, second.state);
    expect(third.state.steps.v).toMatchObject({ status: "blocked", attempts: 3 });
    expect(third.result).toMatchObject({ status: "blocked" });
  });

  it("passes after resume once the marker exists", async () => {
    const home = await makeTempHome();
    const { deps } = memoryDeps(home, retrySolution());
    const { state } = await start(deps, null, "file:/r.json");
    await touch(home, "config/late-marker.txt");
    const resumed = await resume(deps, state);
    expect(resumed.result).toEqual({ status: "complete" });
    expect(resumed.state.steps.v).toMatchObject({ status: "done" });
  });
});
