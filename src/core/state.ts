import { chmod, copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crashPoint } from "./crash.js";
import { removeStaleTemps, syncDirectory, syncFile, writeSynced } from "./durable.js";
import { MODES, STEP_STATUSES, type InstallState } from "./types.js";

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

const STATE_BASE = "install-state.json";
const backupPath = (home: string): string => `${statePath(home)}.bak`;

async function backupNote(home: string): Promise<string> {
  try {
    await readFile(backupPath(home));
    return ` A backup of the previous state is at ${backupPath(home)}; copy it over the state file to continue.`;
  } catch {
    return "";
  }
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

function hasValidExtras(value: Record<string, unknown>): boolean {
  const { mode, roles, runtime, skillswiki, work_dir: workDir } = value;
  if (mode !== undefined && !(MODES as readonly unknown[]).includes(mode)) return false;
  if (roles !== undefined && !(isRecord(roles) && typeof roles.decision_maker === "string")) return false;
  if (skillswiki !== undefined && !(isRecord(skillswiki) && typeof skillswiki.url === "string")) return false;
  if (workDir !== undefined && typeof workDir !== "string") return false;
  return runtime === undefined || (isRecord(runtime) && typeof runtime.support_level === "number");
}

export function isInstallState(value: unknown): value is InstallState {
  if (!isRecord(value) || value.schema !== 1 || typeof value.started_at !== "string") return false;
  const { solution, steps, audit_head: head } = value;
  if (!isRecord(solution) || !["ref", "id", "version"].every((key) => typeof solution[key] === "string")) return false;
  if (solution.recipe_version !== undefined && typeof solution.recipe_version !== "string") return false;
  if (!isRecord(steps) || !Object.values(steps).every(isStepRecord)) return false;
  if (!hasValidExtras(value)) return false;
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
    throw new StateCorruptError(`${statePath(home)} is not valid JSON; it was not changed. Restore it or start in a new home.${await backupNote(home)}`);
  }
  if (!isInstallState(parsed)) {
    throw new StateCorruptError(`${statePath(home)} has an unexpected shape; it was not changed.${await backupNote(home)}`);
  }
  return parsed;
}

async function backupCurrent(target: string): Promise<void> {
  const temp = `${target}.bak.${process.pid}.tmp`;
  try {
    await copyFile(target, temp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await chmod(temp, 0o600);
  await syncFile(temp);
  await rename(temp, `${target}.bak`);
}

/** Atomic, durable write: synced temp file, backup of the current file, rename, directory sync. */
export async function saveState(home: string, state: InstallState): Promise<void> {
  const target = statePath(home);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await removeStaleTemps(dir, STATE_BASE);
  await removeStaleTemps(dir, `${STATE_BASE}.bak`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeSynced(temp, `${JSON.stringify(state, null, 2)}\n`);
  await backupCurrent(target);
  crashPoint("state:before-rename");
  await rename(temp, target);
  await syncDirectory(dir);
}
