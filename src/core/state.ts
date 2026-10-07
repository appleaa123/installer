import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
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

const backupPath = (home: string): string => `${statePath(home)}.bak`;
const IGNORED_DIR_SYNC_CODES = ["EISDIR", "EPERM", "EINVAL", "EBADF"];

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
    throw new StateCorruptError(`${statePath(home)} is not valid JSON; it was not changed. Restore it or start in a new home.${await backupNote(home)}`);
  }
  if (!isInstallState(parsed)) {
    throw new StateCorruptError(`${statePath(home)} has an unexpected shape; it was not changed.${await backupNote(home)}`);
  }
  return parsed;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeStaleTemps(dir: string): Promise<void> {
  const pattern = /^install-state\.json\.(\d+)\.tmp$/;
  for (const name of await readdir(dir)) {
    const pid = Number(pattern.exec(name)?.[1]);
    if (pid && pid !== process.pid && !isAlive(pid)) await rm(join(dir, name), { force: true });
  }
}

async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function backupCurrent(target: string): Promise<void> {
  try {
    await copyFile(target, `${target}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await chmod(`${target}.bak`, 0o600);
}

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!IGNORED_DIR_SYNC_CODES.includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

/** Atomic, durable write: synced temp file, backup of the current file, rename, directory sync. */
export async function saveState(home: string, state: InstallState): Promise<void> {
  const target = statePath(home);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await removeStaleTemps(dir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeSynced(temp, `${JSON.stringify(state, null, 2)}\n`);
  await backupCurrent(target);
  crashPoint("state:before-rename");
  await rename(temp, target);
  await syncDirectory(dir);
}
