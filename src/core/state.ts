import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crashPoint } from "./crash.js";
import { STEP_STATUSES, type InstallState } from "./types.js";

export const STATE_FILE = join("state", "install-state.json");

export class StateCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateCorruptError";
  }
}

export function statePath(home: string): string {
  return join(home, STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStepRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.at === "string" &&
    (STEP_STATUSES as readonly unknown[]).includes(value.status) &&
    (value.attempts === undefined || typeof value.attempts === "number")
  );
}

export function isInstallState(value: unknown): value is InstallState {
  if (!isRecord(value) || value.schema !== 1 || typeof value.started_at !== "string") return false;
  const { solution, steps, audit_head: head } = value;
  if (!isRecord(solution) || !["ref", "id", "version"].every((key) => typeof solution[key] === "string")) return false;
  if (!isRecord(steps) || !Object.values(steps).every(isStepRecord)) return false;
  return head === undefined || (isRecord(head) && typeof head.seq === "number" && typeof head.hash === "string");
}

export async function loadState(home: string): Promise<InstallState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateCorruptError(`${statePath(home)} is not valid JSON; it was not changed. Restore it or start in a new home.`);
  }
  if (!isInstallState(parsed)) {
    throw new StateCorruptError(`${statePath(home)} has an unexpected shape; it was not changed.`);
  }
  return parsed;
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export async function saveState(home: string, state: InstallState): Promise<void> {
  const target = statePath(home);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  crashPoint("state:before-rename");
  await rename(temp, target);
}
