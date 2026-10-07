import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { verifyAudit } from "../../src/core/audit.js";
import { loadState, statePath } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { FIXTURE_SCRIPT, GIVE_UP_SCRIPT, operate } from "../operator/scripted-operator.js";

describe("scripted operator", () => {
  it("installs the fixture end to end and reports ready", async () => {
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: FIXTURE_REF, script: FIXTURE_SCRIPT });
    expect(run.final.status).toBe("complete");
    expect(runCli(["report", "--json"], { home }).json).toMatchObject({ overall: "ready", done: 7, total: 7 });
    const state = await loadState(home);
    await expect(verifyAudit(home, state?.audit_head)).resolves.toMatchObject({ ok: true });
  });

  it("reports ready_with_limits when an optional step is given up", async () => {
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: FIXTURE_REF, script: GIVE_UP_SCRIPT });
    expect(run.final.status).toBe("complete");
    expect(runCli(["report", "--json"], { home }).json).toMatchObject({
      overall: "ready_with_limits",
      limited: [{ step_id: "channels.optional-extra" }],
    });
  });

  it("is idempotent: repeating every command after completion changes nothing (R2)", async () => {
    const home = await makeTempHome();
    await operate({ home, solutionRef: FIXTURE_REF, script: FIXTURE_SCRIPT });
    const before = await readFile(statePath(home), "utf8");
    for (const args of [["start", "--solution", FIXTURE_REF], ["next"], ["resume"], ["report"], ["start", "--solution", FIXTURE_REF]]) {
      expect(runCli(args, { home }).code).toBe(0);
    }
    await expect(readFile(statePath(home), "utf8")).resolves.toBe(before);
    const rerun = await operate({ home, solutionRef: FIXTURE_REF, script: FIXTURE_SCRIPT });
    expect(rerun.final.status).toBe("complete");
    await expect(readFile(statePath(home), "utf8")).resolves.toBe(before);
  });
});
