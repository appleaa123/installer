import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyAudit } from "../../src/core/audit.js";
import { loadState } from "../../src/core/state.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { FIXTURE_SCRIPT, operate } from "../operator/scripted-operator.js";

const MARKERS = ["config/base.txt", "config/agent-marker.txt", "config/extra-channel.txt", "config/finished.txt"];

async function snapshot(home: string) {
  const state = await loadState(home);
  const steps = Object.fromEntries(
    Object.entries(state?.steps ?? {}).map(([id, record]) => [id, { status: record.status, value: record.value, attempts: record.attempts ?? 0 }]),
  );
  const files = Object.fromEntries(await Promise.all(MARKERS.map(async (path) => [path, await readFile(join(home, path), "utf8")])));
  return { steps, files };
}

describe("kill between steps (R2, §15.1)", () => {
  it.each(["engine:after-action", "state:before-rename"])("recovers from a SIGKILL at %s on every call", async (point) => {
    const referenceHome = await makeTempHome();
    const reference = await operate({ home: referenceHome, solutionRef: FIXTURE_REF, script: FIXTURE_SCRIPT });
    const expected = await snapshot(referenceHome);
    let totalCrashes = 0;
    for (let atCall = 0; atCall < reference.calls.length; atCall += 1) {
      const home = await makeTempHome();
      const run = await operate({ home, solutionRef: FIXTURE_REF, script: FIXTURE_SCRIPT, crash: { point, atCall } });
      totalCrashes += run.crashed;
      expect(run.final.status).toBe("complete");
      await expect(snapshot(home)).resolves.toEqual(expected);
      const state = await loadState(home);
      await expect(verifyAudit(home, state?.audit_head)).resolves.toMatchObject({ ok: true });
    }
    expect(totalCrashes).toBeGreaterThan(0);
  }, 300_000);
});
