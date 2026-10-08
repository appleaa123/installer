import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { crashPoint } from "./crash.js";
import { removeStaleTemps, syncDirectory, writeSynced } from "./durable.js";
import { StateCorruptError } from "./state.js";

/**
 * Records kept as one JSON file per integer id (`<id>.json`) in a folder under the engine home (D57).
 * A new id is taken with a hard link, which never replaces an existing file, so two processes never
 * get the same id; an update is a synced temp file renamed over the old one; `claimOnce` is an
 * exclusive create, so exactly one caller ever wins it.
 */
export interface NumberedRecord {
  readonly id: number;
}

const RECORD_NAME = /^([1-9]\d*)\.json$/;
const NEW_BASE = "new";
const TEMP_BASE = "update";

let queue: Promise<unknown> = Promise.resolve();

/** One write at a time inside this process, so its temp file names never collide. */
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function folder(home: string, dir: string): Promise<string> {
  const path = await confinedPath(home, dir);
  await mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

async function names(home: string, dir: string): Promise<string[]> {
  try {
    return await readdir(await confinedPath(home, dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function listIds(home: string, dir: string): Promise<number[]> {
  return (await names(home, dir)).flatMap((name) => RECORD_NAME.exec(name)?.[1] ?? []).map(Number).sort((a, b) => a - b);
}

export async function readRecord<T extends NumberedRecord>(home: string, dir: string, id: number, isValid: (value: unknown) => value is T): Promise<T | null> {
  const path = await confinedPath(home, join(dir, `${id}.json`));
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isValid(parsed) || parsed.id !== id) throw new StateCorruptError(`${path} is damaged; it was not changed. Restore it from a copy, or remove it.`);
  return parsed;
}

export async function listRecords<T extends NumberedRecord>(home: string, dir: string, isValid: (value: unknown) => value is T): Promise<T[]> {
  const records: T[] = [];
  for (const id of await listIds(home, dir)) {
    const record = await readRecord(home, dir, id, isValid);
    if (record) records.push(record);
  }
  return records;
}

/** Writes `build(id)` under the next free id; retries with the following id when another process took it first. */
export function createRecord<T extends NumberedRecord>(home: string, dir: string, build: (id: number) => T): Promise<T> {
  return serial(async () => {
    const path = await folder(home, dir);
    await removeStaleTemps(path, NEW_BASE);
    const temp = join(path, `${NEW_BASE}.${process.pid}.tmp`);
    let id = ((await listIds(home, dir)).at(-1) ?? 0) + 1;
    try {
      for (;;) {
        const record = build(id);
        await writeSynced(temp, `${JSON.stringify(record, null, 2)}\n`);
        try {
          await link(temp, join(path, `${id}.json`));
          await syncDirectory(path);
          return record;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          id += 1;
        }
      }
    } finally {
      await rm(temp, { force: true });
    }
  });
}

/** Atomic replace of an existing record. */
export function replaceRecord<T extends NumberedRecord>(home: string, dir: string, record: T): Promise<void> {
  return serial(async () => {
    const path = await folder(home, dir);
    await removeStaleTemps(path, TEMP_BASE);
    const temp = join(path, `${TEMP_BASE}.${process.pid}.tmp`);
    await writeSynced(temp, `${JSON.stringify(record, null, 2)}\n`);
    crashPoint("numbered:before-rename");
    await rename(temp, join(path, `${record.id}.json`));
    await syncDirectory(path);
  });
}

/** True when the record existed and is now gone. */
export function removeRecord(home: string, dir: string, id: number): Promise<boolean> {
  return serial(async () => {
    const path = await confinedPath(home, join(dir, `${id}.json`));
    try {
      await rm(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

/** Exactly one caller, in any process, ever gets true for a given id (D58: single-use tokens). */
export async function claimOnce(home: string, dir: string, id: number): Promise<boolean> {
  const path = join(await folder(home, dir), `${id}.claimed`);
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.sync();
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
