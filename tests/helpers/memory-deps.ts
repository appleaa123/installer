import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AuditEvent, EngineDeps } from "../../src/core/engine.js";
import { parseSolution } from "../../src/core/solution.js";
import type { InstallState, Solution } from "../../src/core/types.js";

export const FIXTURE_PATH = resolve("tests/fixtures/solution-basic.json");
export const FIXTURE_REF = `file:${FIXTURE_PATH}`;

export function basicSolution(): Solution {
  return parseSolution(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
}

export function fixedClock(startIso = "2026-01-01T00:00:00.000Z", stepMs = 1000): () => string {
  let time = Date.parse(startIso);
  return () => {
    const iso = new Date(time).toISOString();
    time += stepMs;
    return iso;
  };
}

export function memoryDeps(home: string, solution: Solution, now: () => string = fixedClock()) {
  const saved: InstallState[] = [];
  const events: AuditEvent[] = [];
  const deps: EngineDeps = {
    home,
    solution,
    now,
    save: async (state) => {
      saved.push(state);
    },
    audit: async (event) => {
      events.push(event);
      return { seq: events.length, hash: `hash-${events.length}` };
    },
  };
  return { deps, saved, events };
}
