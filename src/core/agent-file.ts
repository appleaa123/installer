import { lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import { InputError } from "./inputs.js";

/**
 * Reminding in chat (9.12 item 2, D154): one short section in the agent-level file (`CLAUDE.md`, `AGENTS.md`) lists
 * the owner's workflows and the skills each uses. TaskFollow writes only the lines between its two markers and keeps
 * every other byte of the file, its line endings and its mode. A file with a broken section is refused, never guessed.
 */
export const SECTION_BEGIN = "<!-- taskfollow:begin (TaskFollow rewrites only the lines between these markers) -->";
export const SECTION_END = "<!-- taskfollow:end -->";
const DESCRIPTION_LIMIT = 200;
const NEW_FILE_MODE = 0o644;

export interface WorkflowLine {
  readonly workflow: string;
  readonly description: string;
  readonly skills: readonly string[];
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DESCRIPTION_LIMIT ? `${flat.slice(0, DESCRIPTION_LIMIT - 1)}…` : flat;
};

/** A local skill by name and where it is (relative to the install folder when inside it); a Skills Wiki skill as its reference. */
function skillLabel(ref: string, workDir: string): string {
  if (ref.startsWith("skillswiki:")) return ref;
  const rel = relative(workDir, ref);
  const shown = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : ref;
  return `${basename(ref)} (\`${shown}\`)`;
}

/** D172: the opportunity rule (9.4), pointing to INSTALL.md's operator rule 14, for chat outside a setup session. */
const OPPORTUNITY = "When you notice work that repeats, offer to set it up as a workflow (INSTALL.md, operator rule 14); nothing is created without the owner's yes.";

export function sectionText(lines: readonly WorkflowLine[], workDir: string): string {
  const intro = "TaskFollow runs these workflows for the owner. When the owner asks about this work in chat, use the skills listed for it. Always ask the owner before sending anything to a customer, paying, anything legal, or deleting.";
  const items = lines.map((line) => {
    const skills = line.skills.length === 0 ? "" : ` Skills: ${line.skills.map((ref) => skillLabel(ref, workDir)).join(", ")}`;
    const description = oneLine(line.description);
    return `- **${line.workflow}**${description ? `: ${description}${/[.!?…]$/.test(description) ? "" : "."}` : ""}${skills}`;
  });
  return ["## TaskFollow workflows", "", intro, "", OPPORTUNITY, "", ...(items.length === 0 ? ["No workflows yet."] : items)].join("\n");
}

const count = (text: string, part: string): number => text.split(part).length - 1;
const brokenMessage = (file: string): string => `${file} has a TaskFollow section that is not closed; fix or remove the line '${SECTION_BEGIN}' and try again`;

/**
 * The file TaskFollow actually writes: the file itself, or, when it is a link (for example CLAUDE.md -> AGENTS.md),
 * the file it points to, so the link stays. A link to nothing is refused.
 */
async function targetOf(file: string): Promise<string> {
  let linked: boolean;
  try {
    linked = (await lstat(file)).isSymbolicLink();
  } catch {
    return file;
  }
  if (!linked) return file;
  try {
    return await realpath(file);
  } catch {
    throw new InputError(`${file} is a link that points to a file that does not exist; fix or remove the link and try again`);
  }
}

/** The file's text, or null when it does not exist; one that cannot be read, or has a broken section, is refused. */
export async function readSection(file: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(await targetOf(file), "utf8");
  } catch (error) {
    if (error instanceof InputError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InputError(`${file} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); fix its permissions or move it away, then try again`);
  }
  const [begins, ends] = [count(text, SECTION_BEGIN), count(text, SECTION_END)];
  const ok = (begins === 0 && ends === 0) || (begins === 1 && ends === 1 && text.indexOf(SECTION_BEGIN) < text.indexOf(SECTION_END));
  if (!ok) throw new InputError(brokenMessage(file));
  return text;
}

const eolOf = (text: string): string => (text.includes("\r\n") ? "\r\n" : "\n");

async function modeOf(file: string): Promise<number> {
  try {
    return (await stat(await targetOf(file))).mode & 0o777;
  } catch {
    return NEW_FILE_MODE;
  }
}

/** Writes through a temporary file in the same folder, so the file is never half written; the mode is kept. */
async function replaceFile(file: string, text: string, mode: number): Promise<void> {
  const target = await targetOf(file);
  const temp = `${target}.taskfollow-tmp`;
  try {
    await writeFile(temp, text, { mode });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Puts `body` between the markers: creates the file, appends to it, or replaces the old section. */
export async function writeSection(file: string, body: string): Promise<{ readonly created: boolean }> {
  const text = await readSection(file);
  const eol = eolOf(text ?? "");
  const section = [SECTION_BEGIN, ...body.split("\n"), SECTION_END].join(eol);
  const mode = await modeOf(file);
  if (text === null) {
    await replaceFile(file, `${section}${eol}`, NEW_FILE_MODE);
    return { created: true };
  }
  if (text.includes(SECTION_BEGIN)) {
    const start = text.indexOf(SECTION_BEGIN);
    const end = text.indexOf(SECTION_END) + SECTION_END.length;
    await replaceFile(file, `${text.slice(0, start)}${section}${text.slice(end)}`, mode);
    return { created: false };
  }
  const separator = text === "" ? "" : text.endsWith(eol) ? eol : `${eol}${eol}`;
  await replaceFile(file, `${text}${separator}${section}${eol}`, mode);
  return { created: false };
}

/** Takes the section out again; a file TaskFollow created that holds nothing else is deleted. */
export async function removeSection(file: string, created: boolean): Promise<"removed" | "deleted" | "absent"> {
  const text = await readSection(file);
  if (text === null || !text.includes(SECTION_BEGIN)) return "absent";
  const eol = eolOf(text);
  let before = text.slice(0, text.indexOf(SECTION_BEGIN));
  let after = text.slice(text.indexOf(SECTION_END) + SECTION_END.length);
  if (after.startsWith(eol)) after = after.slice(eol.length);
  if (before.endsWith(`${eol}${eol}`)) before = before.slice(0, -eol.length);
  else if (before === "" && after.startsWith(eol)) after = after.slice(eol.length);
  const rest = `${before}${after}`;
  if (created && rest.trim() === "") {
    await rm(await targetOf(file), { force: true });
    return "deleted";
  }
  await replaceFile(file, rest, await modeOf(file));
  return "removed";
}

/** Undoes a change made in this call: the text read before (`readSection`), or no file when there was none. */
export async function restoreFile(file: string, original: string | null): Promise<void> {
  if (original === null) {
    await rm(file, { force: true });
    return;
  }
  await replaceFile(file, original, await modeOf(file));
}
