import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
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
/** A saved attachment as the tools name it: exactly what saveAttachments returns. */
export const ATTACHMENT_REF = /^data\/inbox-files\/[0-9a-f]{16}\/[^/\\]+$/;
const TYPES: Readonly<Record<string, string>> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown", zip: "application/zip", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
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

export interface LoadedAttachment {
  readonly ref: string;
  readonly filename: string;
  readonly type: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

/** A saved attachment for sending: only a reference of exactly the saved form, never an arbitrary path. */
export async function loadAttachment(home: string, ref: string): Promise<LoadedAttachment> {
  if (!ATTACHMENT_REF.test(ref)) throw new InputError("Attachments must be files saved from received messages (see channel.inbox, field 'attachments')");
  let bytes: Buffer;
  try {
    bytes = await readFile(await absolute(home, ref));
  } catch {
    throw new InputError(`No saved attachment '${ref}': it may have been removed by retention`);
  }
  const filename = ref.split("/").at(-1) ?? "attachment";
  return { ref, filename, type: TYPES[filename.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream", bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
