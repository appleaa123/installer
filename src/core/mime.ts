/**
 * Just enough of RFC 5322 / MIME to read what a person typed: the sender's address, the subject, the message ids
 * and the first `text/plain` part, decoded (base64, quoted-printable, charset). HTML-only mail and attachments
 * are not read in v1; quoted earlier messages are cut, so a reply code is the first thing in the text.
 */
export interface ParsedMail {
  readonly from: string;
  readonly subject: string;
  readonly message_id: string;
  readonly in_reply_to: string;
  readonly text: string;
}

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

/** The first text/plain part, looking inside multipart parts up to three levels deep. */
function plainText(headers: Headers, body: string, depth: number): string | null {
  const type = (headers["content-type"] ?? "text/plain").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "text/plain") return decodePart(headers, body);
  const boundary = param(headers["content-type"] ?? "", "boundary");
  if (!type.startsWith("multipart/") || boundary === "" || depth >= MAX_DEPTH) return null;
  const parts = body.split(`--${boundary}`).slice(1, -1);
  for (const part of parts) {
    const inner = split(part.replace(/^\r?\n/, ""));
    const found = plainText(inner.headers, inner.body, depth + 1);
    if (found !== null) return found;
  }
  return null;
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
  return {
    from: address(header("from")), subject: decodeWords(header("subject")), message_id: header("message-id"), in_reply_to: header("in-reply-to"),
    text: withoutQuotes(plainText(headers, body, 0) ?? ""),
  };
}
