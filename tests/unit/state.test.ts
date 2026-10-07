import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { StateCorruptError, loadState, saveState, statePath } from "../../src/core/state.js";
import type { InstallState } from "../../src/core/types.js";
import { makeTempHome } from "../helpers/temp-home.js";

const SAMPLE: InstallState = {
  schema: 1,
  solution: { ref: "file:/tmp/solution.json", id: "fixture-basic", version: "1.0.0" },
  started_at: "2026-01-01T00:00:00.000Z",
  steps: { "mode.shared-work": { status: "done", at: "2026-01-01T00:00:05.000Z", by: "human", value: "yes" } },
  audit_head: { seq: 3, hash: "a".repeat(64) },
};

async function writeRaw(home: string, raw: string): Promise<void> {
  await mkdir(dirname(statePath(home)), { recursive: true });
  await writeFile(statePath(home), raw, "utf8");
}

describe("state store", () => {
  it("returns null when no install exists", async () => {
    const home = await makeTempHome();
    await expect(loadState(home)).resolves.toBeNull();
  });

  it("round-trips a state", async () => {
    const home = await makeTempHome();
    await saveState(home, SAMPLE);
    await expect(loadState(home)).resolves.toEqual(SAMPLE);
  });

  it("leaves no temp files behind after a save", async () => {
    const home = await makeTempHome();
    await saveState(home, SAMPLE);
    const files = await readdir(dirname(statePath(home)));
    expect(files).toEqual(["install-state.json"]);
  });

  it("keeps the previous state as a backup after a second save", async () => {
    const home = await makeTempHome();
    await saveState(home, SAMPLE);
    const second: InstallState = { ...SAMPLE, audit_head: { seq: 4, hash: "b".repeat(64) } };
    await saveState(home, second);
    const dir = dirname(statePath(home));
    expect(await readdir(dir)).toEqual(["install-state.json", "install-state.json.bak"]);
    expect(JSON.parse(await readFile(`${statePath(home)}.bak`, "utf8"))).toEqual(SAMPLE);
    await expect(loadState(home)).resolves.toEqual(second);
    if (process.platform !== "win32") expect((await stat(`${statePath(home)}.bak`)).mode & 0o777).toBe(0o600);
  });

  it("removes temp files left by dead processes but keeps those of live ones", async () => {
    const home = await makeTempHome();
    const dead = 999999;
    expect(() => process.kill(dead, 0)).toThrow(/ESRCH|kill/);
    await mkdir(dirname(statePath(home)), { recursive: true });
    const deadTemp = `${statePath(home)}.${dead}.tmp`;
    const liveTemp = `${statePath(home)}.${process.ppid}.tmp`;
    await writeFile(deadTemp, "{}", "utf8");
    await writeFile(liveTemp, "{}", "utf8");
    await saveState(home, SAMPLE);
    const files = await readdir(dirname(statePath(home)));
    expect(files).not.toContain(`install-state.json.${dead}.tmp`);
    expect(files).toContain(`install-state.json.${process.ppid}.tmp`);
  });

  it("removes a backup temp file left by a dead process on the next save", async () => {
    const home = await makeTempHome();
    await saveState(home, SAMPLE);
    const staleBackupTemp = `${statePath(home)}.bak.999999.tmp`;
    await writeFile(staleBackupTemp, "{ half", "utf8");
    await saveState(home, SAMPLE);
    expect(await readdir(dirname(statePath(home)))).toEqual(["install-state.json", "install-state.json.bak"]);
  });

  it("names the backup when the state file is corrupt and changes neither file", async () => {
    const home = await makeTempHome();
    await saveState(home, SAMPLE);
    await saveState(home, SAMPLE);
    await writeFile(statePath(home), "{ half", "utf8");
    const backupBefore = await readFile(`${statePath(home)}.bak`, "utf8");
    await expect(loadState(home)).rejects.toThrow(`A backup of the previous state is at ${statePath(home)}.bak; copy it over the state file to continue.`);
    await expect(readFile(statePath(home), "utf8")).resolves.toBe("{ half");
    await expect(readFile(`${statePath(home)}.bak`, "utf8")).resolves.toBe(backupBefore);
  });

  it("rejects a half-written file without touching it", async () => {
    const home = await makeTempHome();
    const raw = '{"schema":1,"solution":{"ref":';
    await writeRaw(home, raw);
    await expect(loadState(home)).rejects.toBeInstanceOf(StateCorruptError);
    await expect(readFile(statePath(home), "utf8")).resolves.toBe(raw);
  });

  it("rejects a hand-edited file with the wrong shape", async () => {
    const home = await makeTempHome();
    await writeRaw(home, JSON.stringify({ ...SAMPLE, steps: { x: { status: "finished", at: "now" } } }));
    await expect(loadState(home)).rejects.toThrow(/unexpected shape/);
  });

  it("rejects an unknown schema version", async () => {
    const home = await makeTempHome();
    await writeRaw(home, JSON.stringify({ ...SAMPLE, schema: 2 }));
    await expect(loadState(home)).rejects.toBeInstanceOf(StateCorruptError);
  });
});
