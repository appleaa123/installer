import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
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

  it("stops a dry run that needs a model's judgment with the steps to give it a model key", async () => {
    const home = await makeTempHome();
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    expect(runCli(["start", "--solution", `file:${await pinnedStarter()}`], { home, env }).code).toBe(0);
    const added = runCli(["workflow", "add", "brief", "--value", JSON.stringify({ description: "Each morning, tell me what is new.", tools: ["memo.list"] })], { home, env });
    expect(added.code, added.stderr).toBe(0);
    const dry = runCli(["dryrun", "brief"], { home, env });
    const text = `${dry.stdout}${dry.stderr}`;
    expect(text).toContain("taskfollow model --value");
    expect(text).toContain("taskfollow secret model");
  });

  it("passes the dry run once a direct model is set up (a fake model server, never a real one)", async () => {
    const { startFakeModel } = await import("../helpers/fake-model.js");
    const { modelCommand } = await import("../../src/core/model.js");
    const { setSecret } = await import("../../src/core/keychain.js");
    const { dryrunCommand, lifecycleStatus, workflowCommand } = await import("../../src/core/lifecycle.js");
    const fake = await startFakeModel();
    try {
      const home = await makeTempHome();
      const env = { ...fake.env, INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
      expect(runCli(["start", "--solution", `file:${await pinnedStarter()}`], { home, env }).code).toBe(0);
      // The CLI runs synchronously, which would block this process's fake model, so the rest runs the same commands in-process.
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const now = () => "2026-10-17T12:00:00.000Z";
      // What the person does in their own terminal (taskfollow model, taskfollow secret model), done here directly.
      await modelCommand(home, JSON.stringify({ provider: "anthropic", model: "test-model" }), now, true);
      await setSecret("model", fake.key, env);
      fake.answer(JSON.stringify({ tool: "done", summary: "Nothing new today." }));
      await workflowCommand(home, "add", "brief", JSON.stringify({ description: "Each morning, tell me what is new.", tools: ["memo.list"] }), now);
      const dry = await dryrunCommand(home, "brief", undefined, { interactive: false }, now);
      expect(dry).toMatchObject({ dry_runs: [{ workflow: "brief", status: "completed" }] });
      expect(await lifecycleStatus(home)).toEqual([expect.objectContaining({ id: "brief", ran: true })]);
      expect(fake.requests().length).toBeGreaterThan(0);
      const report = runCli(["report"], { home, env });
      expect(report.stdout).toMatch(/⚠️ Limited +Connect your agent to the installer's tools — [^\n]*taskfollow tool/);
    } finally {
      vi.unstubAllEnvs();
      await fake.stop();
    }
  });
});
