import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
