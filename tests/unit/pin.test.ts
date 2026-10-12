import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
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

  it.skipIf(process.platform === "win32")("refuses a solution folder that is a link to outside the home (D34)", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await symlink(outside, join(home, "solution"));
    await expect(writePinnedSolution(home, "{}")).rejects.toThrow(/symbolic link/);
    await expect(loadPinnedSolution(home)).rejects.toThrow(/symbolic link/);
    await expect(readdir(outside)).resolves.toEqual([]);
  });
});
