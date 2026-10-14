import { createHash } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { cleanText, scanInjection, type InboundEnvelope, type InboundFile } from "./envelope.js";
import { InputError } from "./inputs.js";
import { safeFileName } from "./mime.js";

/**
 * Files that arrive with a message (D132). Each is kept under `data/inbox-files/<16 hex of the message>/<name>`, private
 * to the user, and listed on the message as a relative path. They are inert data: nothing opens, runs or renders them.
 * Retention removes them with their message. Only text-like types can be read back, and only as untrusted text.
 */
export const ATTACHMENTS_DIR = "data/inbox-files";
export const MAX_READ_CHARS = 20_000;
const TEXT_FILE = /\.(txt|csv|tsv|md|json|log|ics|xml)$/i;

const folderOf = (envelope: Pick<InboundEnvelope, "channel" | "message_id">): string =>
  `${ATTACHMENTS_DIR}/${createHash("sha256").update(`${envelope.channel}\n${envelope.message_id}`).digest("hex").slice(0, 16)}`;

const absolute = (home: string, reference: string): Promise<string> => confinedPath(home, join(...reference.split("/")));

/** Saves the files and returns their relative paths; the name is made safe again here, whatever the caller did. */
export async function saveAttachments(home: string, envelope: Pick<InboundEnvelope, "channel" | "message_id">, files: readonly InboundFile[]): Promise<string[]> {
  const folder = folderOf(envelope);
  await mkdir(await absolute(home, folder), { recursive: true, mode: 0o700 });
  const saved: string[] = [];
  for (const file of files) {
    const reference = `${folder}/${safeFileName(file.name)}`;
    await writeFile(await absolute(home, reference), file.bytes, { mode: 0o600 });
    saved.push(reference);
  }
  return saved;
}

/** Removes the folders of the given references (retention, D102). */
export async function removeAttachments(home: string, references: readonly string[]): Promise<void> {
  for (const folder of new Set(references.map((reference) => reference.split("/").slice(0, -1).join("/")))) {
    if (folder.startsWith(`${ATTACHMENTS_DIR}/`)) await rm(await absolute(home, folder), { recursive: true, force: true });
  }
}

export interface AttachmentRead {
  readonly name: string;
  readonly size: number;
  readonly text?: string;
  readonly truncated?: boolean;
  readonly injection?: readonly string[];
  readonly note?: string;
}

/** Reads one saved attachment of a message by name (never by path): the start of a text-like file, cleaned and scanned. */
export async function readAttachment(home: string, references: readonly string[], name: string): Promise<AttachmentRead> {
  const reference = references.find((candidate) => candidate.split("/").at(-1) === name);
  if (!reference) throw new InputError(`This message has no attachment named '${name}'`);
  const handle = await open(await absolute(home, reference), "r");
  try {
    const { size } = await handle.stat();
    if (!TEXT_FILE.test(name)) return { name, size, note: "This file type cannot be read here: ask the person to open it" };
    const buffer = Buffer.alloc(Math.min(size, MAX_READ_CHARS * 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    const text = cleanText(raw).slice(0, MAX_READ_CHARS);
    return { name, size, text, truncated: size > bytesRead || cleanText(raw).length > MAX_READ_CHARS, injection: scanInjection(raw) };
  } finally {
    await handle.close();
  }
}
