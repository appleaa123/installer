import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveInHome } from "./actions.js";
import { SolutionError, parseSolutionText } from "./solution.js";
import type { Solution } from "./types.js";

export const PINNED_SOLUTION = join("solution", "solution.json");

/** Atomic write of the solution text the install runs from, so the source file can move or change. */
export async function writePinnedSolution(home: string, text: string): Promise<void> {
  const target = resolveInHome(home, PINNED_SOLUTION);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, text, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

export async function loadPinnedSolution(home: string): Promise<{ solution: Solution; text: string }> {
  const path = resolveInHome(home, PINNED_SOLUTION);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new SolutionError(`The pinned solution file ${path} is missing; this install cannot continue from it`);
  }
  return { solution: parseSolutionText(text, path), text };
}
