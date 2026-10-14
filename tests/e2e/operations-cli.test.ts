import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { STATE_FILE } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** A started install of the basic fixture; the CLI runs without a terminal on stdin, like an agent's shell. */
async function install(): Promise<string> {
  const home = await makeTempHome();
  expect(runCli(["start", "--solution", FIXTURE_REF], { home }).code).toBe(0);
  return home;
}

const audited = async (home: string, event: string): Promise<boolean> => (await readFile(join(home, AUDIT_FILE), "utf8")).includes(`"event":"${event}"`);

describe("taskpilot doctor, pause, host, packs, retention, support and uninstall (§6.6, D101–D110)", () => {
  it("pauses from the agent's shell, and leaves unpausing to a person's terminal", async () => {
    const home = await install();
    expect(runCli(["pause", "--reason", "checking"], { home }).json).toMatchObject({ status: "paused", by: "agent", reason: "checking" });
    const refused = runCli(["unpause"], { home });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("in their own terminal") });
    expect(await audited(home, "engine.unpause_refused")).toBe(true);
    expect(runCli(["pause", "status"], { home }).json).toMatchObject({ pause: { paused: true } });
    expect(runCli(["tick"], { home }).json).toMatchObject({ status: "paused" });
  });

  it("runs the doctor, reports a damaged state instead of stopping, and never reads the real OS here", async () => {
    const home = await install();
    const report = runCli(["doctor"], { home });
    expect(report.code).toBe(0);
    expect(report.json).toMatchObject({ checks: expect.arrayContaining([{ id: "host", status: "ok", detail: "host readiness not checked here (INSTALLER_HOST_CHECKS=none)" }]) });
    await writeFile(join(home, STATE_FILE), "{");
    const damaged = runCli(["doctor"], { home });
    expect(damaged.code).toBe(0);
    expect(damaged.json).toMatchObject({ status: "fail", checks: expect.arrayContaining([expect.objectContaining({ id: "state", status: "fail" })]) });
    expect(runCli(["doctor"], { home: await makeTempHome() }).code).toBe(2);
  });

  it("refuses a shorter retention, a pack switch and an uninstall from the agent's shell", async () => {
    const home = await install();
    expect(runCli(["retention", "--value", "120"], { home }).json).toMatchObject({ status: "saved", retention: { days: 120 } });
    expect(runCli(["retention", "--value", "30"], { home }).code).toBe(2);
    expect(runCli(["packs", "switch", "demo"], { home }).code).toBe(2);
    expect(runCli(["uninstall"], { home }).code).toBe(2);
    expect([await audited(home, "retention.refused"), await audited(home, "pack.switch_refused"), await audited(home, "engine.uninstall_refused")]).toEqual([true, true, true]);
    expect(runCli(["packs"], { home }).json).toMatchObject({ packs: [] });
  });

  it("writes a support bundle, prints the boot service commands, and adds the operations to the report", async () => {
    const home = await install();
    const bundle = runCli(["support", "bundle"], { home }).json as { file: string };
    await access(bundle.file);
    expect(runCli(["support"], { home }).code).toBe(2);
    expect(runCli(["host"], { home }).json).toMatchObject({ status: "skipped" });
    const service = runCli(["host", "service", "install"], { home }).json as { commands: string[] };
    expect(service.commands.some((command) => command.startsWith("sudo "))).toBe(true);
    expect(runCli(["report", "--json"], { home }).json).toMatchObject({ operations: { paused: null, data_flow: [expect.objectContaining({ party: "Support (only when you send it)" })] } });
    expect(runCli(["report"], { home }).stdout).toContain("🔀 Data flow");
  });
});
