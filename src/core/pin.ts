import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import { removeStaleTemps, syncDirectory, writeSynced } from "./durable.js";
import { SolutionError, parseSolutionText } from "./solution.js";
import type { Solution } from "./types.js";

export const PINNED_SOLUTION = join("solution", "solution.json");

/** Atomic write of the solution text the install runs from, so the source file can move or change. */
export async function writePinnedSolution(home: string, text: string): Promise<void> {
  const target = await confinedPath(home, PINNED_SOLUTION);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await removeStaleTemps(dir, basename(target));
  const temp = `${target}.${process.pid}.tmp`;
  await writeSynced(temp, text);
  await rename(temp, target);
  await syncDirectory(dir);
}

export async function loadPinnedSolution(home: string): Promise<{ solution: Solution; text: string }> {
  const path = await confinedPath(home, PINNED_SOLUTION);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new SolutionError(`The pinned solution file ${path} is missing; this install cannot continue from it`);
    throw new SolutionError(`Cannot read the pinned solution file ${path} (${code ?? "unknown error"})`);
  }
  return { solution: parseSolutionText(text, path), text };
}
