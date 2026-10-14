import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAction } from "../../src/core/actions.js";
import { advance, resume, retryCommand, start } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { buildReport } from "../../src/core/report.js";
import { parseSolution } from "../../src/core/solution.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const WRITE = { step_id: "pre.write", phase: "PREFLIGHT", type: "auto", title: "Write a file", why: "Needed.", blocking: true, auto: { action: "write_file", args: { path: "config/a.txt", content: "x\n" } } };
const solution = () => parseSolution({ id: "failing", version: "1", steps: [WRITE] });

/** A read-only config folder makes write_file fail the way a full disk or a lost permission would. */
async function lockedHome(): Promise<string> {
  const home = await makeTempHome();
  await mkdir(join(home, "config"), { mode: 0o500 });
  return home;
}

const unlock = (home: string) => chmod(join(home, "config"), 0o700);
const cannotLock = process.platform === "win32" || process.getuid?.() === 0;

describe("retryCommand", () => {
  it("sends auto steps back through taskfollow resume", () => {
    expect(retryCommand(solution().steps[0]!)).toBe("taskfollow resume");
  });
});

describe.skipIf(cannotLock)("an auto step whose action fails (D53)", () => {
  it("write_file reports a failure the person can fix, not an internal error", async () => {
    const home = await lockedHome();
    await expect(runAction(home, WRITE.auto)).rejects.toThrow(ActionFailure);
    await expect(runAction(home, WRITE.auto)).rejects.toThrow("Cannot write config/a.txt (EACCES)");
  });

  it("is recorded as failed with the hint and retried through resume", async () => {
    const home = await lockedHome();
    const { deps } = memoryDeps(home, solution());
    const first = await start(deps, null, "file:/f.json");
    expect(first.result).toMatchObject({ status: "step", view: { status: "failed", attempts: 1, hint: "Cannot write config/a.txt (EACCES)", resume: "taskfollow resume" } });
    expect(buildReport(deps.solution, first.state).needs_you[0]?.detail).toContain("→ then run 'taskfollow resume'");
    const again = await advance(deps, first.state);
    expect(again.result).toEqual(first.result);
    await unlock(home);
    const fixed = await resume(deps, first.state);
    expect(fixed.result).toEqual({ status: "complete" });
    expect(fixed.state.steps["pre.write"]).toMatchObject({ status: "done", by: "engine" });
  });

  it("blocks on the third failure with the reason recorded", async () => {
    const home = await lockedHome();
    const { deps } = memoryDeps(home, solution());
    let { state } = await start(deps, null, "file:/f.json");
    state = (await resume(deps, state)).state;
    const third = await resume(deps, state);
    expect(third.result).toMatchObject({ status: "blocked", view: { attempts: 3 } });
    expect(third.state.steps["pre.write"]).toMatchObject({ status: "blocked", attempts: 3, reason: "action failed 3 times" });
    await unlock(home);
    expect((await resume(deps, third.state)).result).toEqual({ status: "complete" });
  });
});

describe("authoring errors are not failures", () => {
  it("an action with a bad argument still throws and records nothing", async () => {
    const home = await makeTempHome();
    const bad = parseSolution({ id: "bad", version: "1", steps: [{ ...WRITE, auto: { action: "write_file", args: { path: 42 } } }] });
    const { deps, saved } = memoryDeps(home, bad);
    await expect(start(deps, null, "file:/b.json")).rejects.toThrow(InputError);
    expect(saved.at(-1)?.steps["pre.write"]).toBeUndefined();
  });
});
