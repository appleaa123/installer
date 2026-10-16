import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { confinedPath } from "./actions.js";
import { READ_TOOL } from "./agent-hook.js";
import { ATTACHMENT_REF, ATTACHMENTS_DIR } from "./attachments.js";
import { InputError } from "./inputs.js";
import { MAX_ATTACHMENT_BYTES } from "./mime.js";

/**
 * Item 6a, Task 4 (D171): a task step that lists `Read` reads only files TaskFollow's code chose, never a path the
 * model picked. `read_from: "attachments"` takes the saved attachments named in the step's own input (D133's form);
 * `read_from: "meeting-notes"` takes the newest regular file in `<install folder>/meeting-notes/`. Each is checked
 * inside its folder after `realpath`, links are skipped, and the attachment size cap applies. The chosen absolute
 * paths go to the hook (`hook.json` `files`), which allows a `Read` of exactly those. Accepted limit: a process
 * running as the same computer user could swap a file between the hook's check and the agent's read (D159).
 */
export { READ_TOOL };
export const READ_FROM = ["attachments", "meeting-notes"] as const;
export type ReadFrom = (typeof READ_FROM)[number];
export const NOTES_DIR = "meeting-notes";
export const NO_NOTE = "There is no note in meeting-notes/ yet. Put the notes or transcript there as a file, or paste them in this chat.";
export const NO_ATTACHMENT = "This email has no attachment TaskFollow could hand over, so nothing was read.";

export interface ChosenFile {
  readonly name: string;
  readonly path: string;
}

const inside = (root: string, path: string): boolean => path.startsWith(root + sep);

/** Every string in the input that is a saved attachment's reference, once each. */
function referencesIn(value: unknown): string[] {
  if (typeof value === "string") return ATTACHMENT_REF.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(referencesIn);
  return [];
}

/** A regular file within the cap, still inside `root` once resolved; null otherwise. */
async function usable(path: string, root: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES) return null;
    const real = await realpath(path);
    return inside(root, real) ? real : null;
  } catch {
    return null;
  }
}

/** The saved attachments the step's input names, each a regular file inside `data/inbox-files/`. */
export async function chooseAttachments(home: string, input: unknown): Promise<ChosenFile[]> {
  const root = await realpath(join(home, ATTACHMENTS_DIR)).catch(() => null);
  if (root === null) return [];
  const chosen: ChosenFile[] = [];
  for (const ref of [...new Set(referencesIn(input))]) {
    const path = await confinedPath(home, join(...ref.split("/"))).catch(() => null);
    const real = path === null ? null : await usable(path, root);
    if (real !== null) chosen.push({ name: ref.split("/").at(-1) ?? ref, path: real });
  }
  return chosen;
}

/** The meeting-notes folder of the install folder; refused when it is a link or not a folder. Null when absent. */
export async function notesFolder(workDir: string): Promise<string | null> {
  const folder = join(workDir, NOTES_DIR);
  let info;
  try {
    info = await lstat(folder);
  } catch {
    return null;
  }
  if (info.isSymbolicLink()) throw new InputError(`${folder} is a symbolic link, so TaskFollow will not read from it; make it a plain folder`);
  if (!info.isDirectory()) throw new InputError(`${folder} is not a folder; make it a plain folder for meeting notes`);
  return realpath(folder);
}

/** The newest regular file in `<install folder>/meeting-notes/`, or null when there is none. */
export async function chooseNote(workDir: string): Promise<ChosenFile | null> {
  const folder = await notesFolder(workDir);
  if (folder === null) return null;
  let newest: { file: ChosenFile; mtime: number } | null = null;
  for (const name of await readdir(folder)) {
    const real = await usable(join(folder, name), folder);
    if (real === null) continue;
    const mtime = (await lstat(real)).mtimeMs;
    if (newest === null || mtime > newest.mtime) newest = { file: { name, path: real }, mtime };
  }
  return newest?.file ?? null;
}
