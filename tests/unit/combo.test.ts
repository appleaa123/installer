import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../src/core/actions.js";
import { EngineError, start, submit, verifyStep } from "../../src/core/engine.js";
import { ActionFailure } from "../../src/core/failure.js";
import { setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT } from "../../src/core/mcp.js";
import { URL_MISSING_HINT } from "../../src/core/skillswiki.js";
import { parseSolution } from "../../src/core/solution.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { memoryDeps } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const COMBO_STEP = {
  step_id: "brain.combo", phase: "BRAIN", type: "human_action", title: "Activate the combo", why: "Needed.", blocking: true,
  instructions: ["Open the Skills Wiki dashboard", "Activate the combo"], verify: { check: "combo_active" },
};
const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const fake = await startFakeMcp(env);
  servers.push(fake);
  return fake;
}

async function installWith(url: string) {
  const { deps } = memoryDeps(await makeTempHome(), parseSolution({ id: "c", version: "1", steps: [COMBO_STEP] }));
  const { state } = await start(deps, null, "file:/c.json", "sha", { skillswiki: { url } });
  return { deps, state };
}

beforeEach(async () => {
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("skillswiki", "test-key");
});

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.unstubAllEnvs();
});

describe("the combo step (D37)", () => {
  it("passes once a combo is active in Skills Wiki", async () => {
    const fake = await server();
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "passed" });
    expect(verified.state.steps["brain.combo"]).toMatchObject({ status: "done", by: "human" });
  });

  it("fails with a dashboard hint while no combo is active", async () => {
    const fake = await server({ FAKE_MCP_COMBO: "" });
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "failed", hint: "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again", retry: true });
  });

  it("turns a rejected key into a failed check with the secret hint (Review Focus 3)", async () => {
    const fake = await server({ FAKE_MCP_KEY: "another-key" });
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toEqual({ status: "failed", hint: KEY_REJECTED_HINT, retry: true });
  });

  it("names the url when Skills Wiki is unreachable, and the step can be retried", async () => {
    const fake = await server();
    fake.stop();
    await new Promise((tick) => setTimeout(tick, 50));
    const { deps, state } = await installWith(fake.url);
    const verified = await verifyStep(deps, state, "brain.combo");
    expect(verified.result).toMatchObject({ status: "failed", hint: expect.stringContaining(`Cannot reach Skills Wiki at '${fake.url}'`), retry: true });
    expect(verified.next).toMatchObject({ status: "step", view: { resume: "taskpilot verify brain.combo" } });
  });

  it("cannot be completed with --done", async () => {
    const fake = await server();
    const { deps, state } = await installWith(fake.url);
    await expect(submit(deps, state, "brain.combo", { kind: "done" })).rejects.toThrow(EngineError);
  });

  it("needs the Skills Wiki url from the install state", async () => {
    await expect(runCheck(await makeTempHome(), { check: "combo_active" })).rejects.toThrow(ActionFailure);
    await expect(runCheck(await makeTempHome(), { check: "combo_active" })).rejects.toThrow(URL_MISSING_HINT);
  });
});
