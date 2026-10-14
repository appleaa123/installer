import { saveState } from "../../src/core/state.js";
import type { CapabilityMap, Roles } from "../../src/core/types.js";
import { makeTempHome } from "./temp-home.js";

/** What `taskpilot probe` records for the fake agent: headless calls with schema output (C4). */
export const FAKE_RUNTIME: CapabilityMap = {
  profile: "fake-agent", agent_version: "9.9.9", c2_shell: true, c4_headless: true, c4_schema: true, c5_resume: true, c6_mcp: "not_probed", support_level: 2, tier: "compatible", notes: [],
};
export const OWNER_ROLES: Roles = { decision_maker: "Owner" };

/** An install home whose probe found the fake agent and whose decision maker is Owner; nothing pinned, no channels. */
export async function runnerHome(at = "2026-10-08T12:00:00.000Z"): Promise<string> {
  const home = await makeTempHome();
  await saveState(home, { schema: 1, solution: { ref: "file:x.json", id: "fixture-runner", version: "1.0.0" }, started_at: at, steps: {}, roles: OWNER_ROLES, runtime: FAKE_RUNTIME });
  return home;
}
