/**
 * Just enough of RFC 5322 / MIME to read what a person typed: the sender's address, the subject, the message ids
 * and the first `text/plain` part, decoded (base64, quoted-printable, charset). Mail with only an HTML part is read
 * as plain text (D143): scripts, styles, comments and tags are dropped and never rendered. Quoted earlier messages are cut, so a reply code is the first thing in the text. Attachments are listed with
 * their bytes (D132): the caller saves them; nothing here opens, runs or renders them.
 */
export interface MailAttachment {
  readonly filename: string;
  readonly type: string;
  readonly bytes: Buffer;
}

export interface ParsedMail {
  readonly from: string;
  readonly subject: string;
  readonly message_id: string;
  readonly in_reply_to: string;
  /** The first message of the conversation: the start of References, else In-Reply-To, else this message. */
  readonly thread_root: string;
  readonly text: string;
  readonly attachments: readonly MailAttachment[];
  /** Attachments not kept, each with the reason, so the person is told. */
  readonly skipped: readonly string[];
}

export const MAX_ATTACHMENT_BYTES = 5_000_000;
export const MAX_ATTACHMENTS = 10;

type Headers = Readonly<Record<string, string>>;
const MAX_DEPTH = 3;

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.trim() || "utf-8").decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function quotedPrintable(text: string): Buffer {
  const joined = text.replace(/=\r?\n/g, "");
  return Buffer.from(joined.replace(/=([0-9A-F]{2})/gi, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
}

/** `=?charset?B|Q?…?=` words in a header (RFC 2047). */
export function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(?==\?)/g, "$1");
  return joined.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_whole, charset: string, kind: string, data: string) => {
    const bytes = kind.toLowerCase() === "b" ? Buffer.from(data, "base64") : quotedPrintable(data.replace(/_/g, " "));
    return decodeCharset(bytes, charset);
  });
}

/** Splits at the first empty line; header names lower-cased, folded lines joined. */
function split(raw: string): { headers: Headers; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  const head = match ? raw.slice(0, match.index) : raw;
  const body = match ? raw.slice(match.index + match[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    if (colon > 0 && !Object.hasOwn(headers, name)) headers[name] = line.slice(colon + 1).trim();
  }
  return { headers, body };
}

function param(value: string, name: string): string {
  return new RegExp(`;\\s*${name}\\s*=\\s*"?([^";]+)"?`, "i").exec(value)?.[1]?.trim() ?? "";
}

function decodePart(headers: Headers, body: string): string {
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  const bytes = encoding === "base64" ? Buffer.from(body.replace(/\s+/g, ""), "base64") : encoding === "quoted-printable" ? quotedPrintable(body) : Buffer.from(body, "latin1");
  return decodeCharset(bytes, param(headers["content-type"] ?? "", "charset") || "utf-8");
}

/** The first part of this type (text/plain or text/html) that is not an attachment, up to three levels deep. */
function textPart(headers: Headers, body: string, depth: number, wanted: string): string | null {
  const type = (headers["content-type"] ?? "text/plain").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === wanted) return isAttachment(headers) ? null : decodePart(headers, body);
  const boundary = param(headers["content-type"] ?? "", "boundary");
  if (!type.startsWith("multipart/") || boundary === "" || depth >= MAX_DEPTH) return null;
  const parts = body.split(`--${boundary}`).slice(1, -1);
  for (const part of parts) {
    const inner = split(part.replace(/^\r?\n/, ""));
    const found = textPart(inner.headers, inner.body, depth + 1, wanted);
    if (found !== null) return found;
  }
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The words of an HTML part, as plain text: nothing in it is kept as markup, followed or rendered (D143). */
export function htmlToText(html: string): string {
  const text = html
    .replace(/\r?\n/g, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|blockquote)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(p|div|h[1-6]|tr|table|ul|ol|section|article)\b[^>]*>/gi, "\n\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
      return ENTITIES[name.toLowerCase()] ?? whole;
    });
  return text.split("\n").map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** What the person typed: the plain-text part, else the HTML part as plain text. */
function plainText(headers: Headers, body: string): string | null {
  const plain = textPart(headers, body, 0, "text/plain");
  if (plain !== null) return plain;
  const html = textPart(headers, body, 0, "text/html");
  return html === null ? null : htmlToText(html);
}

function fileNameOf(headers: Headers): string {
  const disposition = headers["content-disposition"] ?? "";
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  return decodeWords(param(disposition, "filename") || param(headers["content-type"] ?? "", "name"));
}

const isAttachment = (headers: Headers): boolean => fileNameOf(headers) !== "" || /^\s*attachment/i.test(headers["content-disposition"] ?? "");

/** A name that cannot leave its folder: no path, no control or reserved characters, no leading dots, at most 100 characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim().replace(/^\.+/, "").trim();
  return cleaned.slice(0, 100) || "attachment";
}

function decodeBytes(headers: Headers, body: string): Buffer {
  const encoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  if (encoding === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64");
  return encoding === "quoted-printable" ? quotedPrintable(body) : Buffer.from(body, "latin1");
}

/** Every non-multipart part with a file name (or marked as an attachment), looking up to three levels deep. */
function collectAttachments(headers: Headers, body: string, depth: number, found: { headers: Headers; body: string }[]): void {
  const type = (headers["content-type"] ?? "text/plain").split(";")[0]?.trim().toLowerCase() ?? "";
  const boundary = param(headers["content-type"] ?? "", "boundary");
  if (type.startsWith("multipart/")) {
    if (boundary === "" || depth >= MAX_DEPTH) return;
    for (const part of body.split(`--${boundary}`).slice(1, -1)) {
      const inner = split(part.replace(/^\r?\n/, ""));
      collectAttachments(inner.headers, inner.body, depth + 1, found);
    }
    return;
  }
  if (isAttachment(headers)) found.push({ headers, body });
}

/** `a.txt` taken twice becomes `a.txt` and `a-2.txt`. */
function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let count = 2; ; count += 1) {
    const candidate = `${stem}-${count}${ext}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function attachmentsOf(headers: Headers, body: string): { attachments: MailAttachment[]; skipped: string[] } {
  const parts: { headers: Headers; body: string }[] = [];
  collectAttachments(headers, body, 0, parts);
  const attachments: MailAttachment[] = [];
  const skipped: string[] = [];
  for (const part of parts) {
    const filename = uniqueName(safeFileName(fileNameOf(part.headers)), attachments.map((entry) => entry.filename));
    const bytes = decodeBytes(part.headers, part.body);
    if (attachments.length >= MAX_ATTACHMENTS) skipped.push(`${filename} (only the first ${MAX_ATTACHMENTS} attachments are kept)`);
    else if (bytes.length > MAX_ATTACHMENT_BYTES) skipped.push(`${filename} (over ${MAX_ATTACHMENT_BYTES / 1_000_000} MB)`);
    else attachments.push({ filename, type: (part.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream", bytes });
  }
  return { attachments, skipped };
}

/** Drops quoted lines and everything from a reply header ("On … wrote:") down. */
export function withoutQuotes(text: string): string {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((line) => /^(On .+ wrote:|-+ ?Original Message ?-+)\s*$/i.test(line.trim()));
  return (cut >= 0 ? lines.slice(0, cut) : lines).filter((line) => !line.startsWith(">")).join("\n").trim();
}

function address(value: string): string {
  return (/<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1] ?? /[^<>\s"]+@[^<>\s"]+/.exec(value)?.[0] ?? "").toLowerCase();
}

export function parseMail(raw: Buffer): ParsedMail {
  const { headers, body } = split(raw.toString("latin1"));
  const header = (name: string): string => decodeCharset(Buffer.from(headers[name] ?? "", "latin1"), "utf-8");
  const references = header("references").match(/<[^<>\s]+>/g) ?? [];
  const inReplyTo = header("in-reply-to");
  const { attachments, skipped } = attachmentsOf(headers, body);
  return {
    from: address(header("from")), subject: decodeWords(header("subject")), message_id: header("message-id"), in_reply_to: inReplyTo,
    thread_root: references[0] ?? /<[^<>\s]+>/.exec(inReplyTo)?.[0] ?? (inReplyTo || header("message-id")),
    text: withoutQuotes(plainText(headers, body) ?? ""), attachments, skipped,
  };
}
