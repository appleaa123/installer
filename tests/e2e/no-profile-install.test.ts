import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";

/**
 * D175: an agent TaskFollow has no profile for (Antigravity, OpenClaw, Hermes, …) gets past the tools step. The probe is
 * pinned to a test profile whose command does not exist, so nothing here can reach a real agent (never strip PATH).
 */
async function pinnedStarter(): Promise<string> {
  const shipped = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { steps: { auto?: { args?: Record<string, unknown> } }[] };
  const probe = shipped.steps[0]?.auto;
  if (probe) probe.args = { profile: "missing-agent" };
  const pinned = join(await makeTempHome(), "starter.json");
  await writeFile(pinned, JSON.stringify(shipped), "utf8");
  return pinned;
}

describe("an install on an agent with no TaskFollow profile (D175)", () => {
  it("reaches the MODE questions in one start", async () => {
    const home = await makeTempHome();
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const started = runCli(["start", "--solution", `file:${await pinnedStarter()}`], { home, env });
    expect(started.code, started.stderr).toBe(0);
    expect(started.json).toMatchObject({ status: "step", view: { step: { step_id: "mode.purpose" } } });
    const state = await loadState(home);
    expect(state?.runtime?.profile).toBeNull();
    expect(state?.steps["preflight.tools"]).toMatchObject({ status: "blocked", attempts: 1 });
    expect(state?.steps["preflight.tools"]?.hint).toContain("taskfollow tool");
  });
});
