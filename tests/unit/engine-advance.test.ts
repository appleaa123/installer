import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineError, advance, start } from "../../src/core/engine.js";
import { parseSolution } from "../../src/core/solution.js";
import { FIXTURE_REF, basicSolution, fixedClock, memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

describe("start", () => {
  it("runs auto and verify steps and stops at the first question", async () => {
    const home = await makeTempHome();
    const { deps, saved, events } = memoryDeps(home, basicSolution());
    const { state, result } = await start(deps, null, FIXTURE_REF);
    expect(result).toMatchObject({ status: "step", view: { step: { step_id: "mode.shared-work" }, status: "pending" } });
    expect(state.steps["preflight.write-config"]?.status).toBe("done");
    expect(state.steps["preflight.check-config"]?.status).toBe("done");
    await expect(access(join(home, "config", "base.txt"))).resolves.toBeUndefined();
    expect(events[0]).toMatchObject({ event: "install.started" });
    expect(saved).toHaveLength(3);
    expect(state.audit_head).toEqual({ seq: 3, hash: "hash-3" });
  });

  it("is idempotent: a second start writes nothing and returns the same step", async () => {
    const home = await makeTempHome();
    const { deps, saved } = memoryDeps(home, basicSolution());
    const first = await start(deps, null, FIXTURE_REF);
    const count = saved.length;
    const second = await start(deps, first.state, FIXTURE_REF);
    expect(second.result).toEqual(first.result);
    expect(saved).toHaveLength(count);
  });

  it("refuses to start a different solution in the same home", async () => {
    const home = await makeTempHome();
    const { deps } = memoryDeps(home, basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF);
    const other = memoryDeps(home, { ...basicSolution(), id: "another-solution" });
    await expect(start(other.deps, state, FIXTURE_REF)).rejects.toThrow(EngineError);
  });

  it("accepts the same solution reached through a different ref", async () => {
    const home = await makeTempHome();
    const { deps } = memoryDeps(home, basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF);
    await expect(start(deps, state, "file:/other/solution.json")).resolves.toMatchObject({ result: { status: "step" } });
  });
});

describe("advance", () => {
  it("runs a failing verify step once and does not re-run it on the next call", async () => {
    const home = await makeTempHome();
    const solution = parseSolution({
      id: "verify-once",
      version: "1",
      steps: [
        { step_id: "v", phase: "PREFLIGHT", type: "verify", title: "Check", why: "Needed.", blocking: true, verify: { check: "file_exists", args: { path: "missing.txt", hint: "missing" } } },
      ],
    });
    const { deps, saved } = memoryDeps(home, solution);
    const first = await start(deps, null, "file:/x.json");
    expect(first.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 1, hint: "missing" } });
    const count = saved.length;
    const again = await advance(deps, first.state);
    expect(again.result).toEqual(first.result);
    expect(saved).toHaveLength(count);
  });

  it("keeps progressing when the host clock jumps backwards (Review Focus 5)", async () => {
    const home = await makeTempHome();
    const backwards = fixedClock("2026-06-01T12:00:00.000Z", -3_600_000);
    const { deps } = memoryDeps(home, basicSolution(), backwards);
    const { state, result } = await start(deps, null, FIXTURE_REF);
    expect(result).toMatchObject({ status: "step", view: { step: { step_id: "mode.shared-work" } } });
    const written = state.steps["preflight.write-config"]?.at ?? "";
    const checked = state.steps["preflight.check-config"]?.at ?? "";
    expect(Date.parse(checked)).toBeLessThan(Date.parse(written));
  });
});

describe("recipe_version", () => {
  it("is stored in the state on a fresh start", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    const { state } = await start(deps, null, FIXTURE_REF, "sha-of-text");
    expect(state.solution.recipe_version).toBe("sha-of-text");
  });
});

describe("start extras", () => {
  it("records the working folder and the Skills Wiki url on a fresh start only", async () => {
    const { deps } = memoryDeps(await makeTempHome(), basicSolution());
    const extras = { work_dir: "/work/team", skillswiki: { url: "https://wiki.test/mcp" } };
    const { state } = await start(deps, null, FIXTURE_REF, "sha", extras);
    expect(state).toMatchObject(extras);
    const again = await start(deps, state, FIXTURE_REF, "sha", { work_dir: "/elsewhere" });
    expect(again.state.work_dir).toBe("/work/team");
  });
});
