import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PINNED_SOLUTION, loadPinnedSolution, writePinnedSolution } from "../../src/core/pin.js";
import { deadPid } from "../helpers/dead-pid.js";
import { makeTempHome } from "../helpers/temp-home.js";

describe("pinned solution", () => {
  it("removes a stale temp file left by a dead process on the next pin write", async () => {
    const home = await makeTempHome();
    const dir = join(home, "solution");
    await mkdir(dir, { recursive: true });
    const dead = deadPid();
    await writeFile(join(dir, `solution.json.${dead}.tmp`), "{}", "utf8");
    await writePinnedSolution(home, "{}");
    expect(await readdir(dir)).toEqual(["solution.json"]);
  });

  it("reports an unreadable pinned path as unreadable, not missing", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, PINNED_SOLUTION), { recursive: true });
    await expect(loadPinnedSolution(home)).rejects.toThrow(/Cannot read the pinned solution file .*solution\.json \(EISDIR\)/);
  });
});
