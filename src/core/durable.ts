import { link, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const IGNORED_DIR_SYNC_CODES = ["EISDIR", "EPERM", "EINVAL", "EBADF"];

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Removes `<base>.<pid>.tmp` files whose process is gone; never the current pid. */
export async function removeStaleTemps(dir: string, base: string): Promise<void> {
  const prefix = `${base}.`;
  for (const name of await readdir(dir)) {
    const match = name.startsWith(prefix) ? /^(\d+)\.tmp$/.exec(name.slice(prefix.length)) : null;
    const pid = Number(match?.[1]);
    if (pid && pid !== process.pid && !isAlive(pid)) await rm(join(dir, name), { force: true });
  }
}

export async function writeSynced(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Creates `path` holding `text`, or returns false when it exists; written aside and linked, so never seen empty. */
export async function createExclusive(path: string, text: string): Promise<boolean> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeSynced(temp, text);
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/** Sync an existing file to disk. */
export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best effort: some platforms cannot fsync a directory. */
export async function syncDirectory(dir: string): Promise<void> {
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
