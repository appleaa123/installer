import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, parseMail, safeFileName } from "../../src/core/mime.js";

const BOUNDARY = "BOUND";
const b64 = (text: string | Buffer): string => Buffer.from(text).toString("base64").replace(/(.{76})/g, "$1\r\n");
const file = (name: string, type: string, content: string | Buffer, extra = ""): string =>
  `--${BOUNDARY}\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"${extra}\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(content)}\r\n`;
const mail = (parts: string, headers = ""): Buffer =>
  Buffer.from(`From: Ada <ada@example.com>\r\nSubject: Report\r\nMessage-ID: <m1@example.com>\r\n${headers}Content-Type: multipart/mixed; boundary="${BOUNDARY}"\r\n\r\n--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nHello there\r\n${parts}--${BOUNDARY}--\r\n`, "latin1");

describe("attachments in a message (D132)", () => {
  it("lists each attachment with its name, type and bytes, and still reads the text", () => {
    const parsed = parseMail(mail(file("report.csv", "text/csv", "name,email\nAda,ada@example.com\n")));
    expect(parsed.text).toBe("Hello there");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "report.csv", type: "text/csv" });
    expect(parsed.attachments[0]?.bytes.toString("utf8")).toBe("name,email\nAda,ada@example.com\n");
  });

  it("does not treat the text body as an attachment, and a message without attachments has none", () => {
    expect(parseMail(mail("")).attachments).toEqual([]);
    expect(parseMail(Buffer.from("From: a@b.co\r\nSubject: s\r\nMessage-ID: <x@y>\r\n\r\nplain\r\n")).attachments).toEqual([]);
  });

  it("reads an encoded file name (RFC 2047 words and RFC 2231 form)", () => {
    const word = parseMail(mail(file("=?UTF-8?B?cmVwb3J0LcOpLnR4dA==?=", "text/plain", "x")));
    expect(word.attachments[0]?.filename).toBe("report-é.txt");
    const star = parseMail(mail(`--${BOUNDARY}\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.txt\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64("x")}\r\n`));
    expect(star.attachments[0]?.filename).toBe("résumé.txt");
  });

  it("keeps a name that cannot escape its folder, never a path", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a/b\\c.txt")).toBe("c.txt");
    expect(safeFileName("  .hidden  ")).toBe("hidden");
    expect(safeFileName("na\u0000me<>:|?*.txt")).toBe("na_me______.txt");
    expect(safeFileName("")).toBe("attachment");
    expect(safeFileName("x".repeat(300)).length).toBeLessThanOrEqual(100);
  });

  it("keeps two files with the same name apart", () => {
    const parsed = parseMail(mail(file("a.txt", "text/plain", "one") + file("a.txt", "text/plain", "two")));
    expect(parsed.attachments.map((entry) => entry.filename)).toEqual(["a.txt", "a-2.txt"]);
  });

  it("does not keep an attachment over the size limit, and says which", () => {
    const parsed = parseMail(mail(file("big.bin", "application/octet-stream", Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)) + file("ok.txt", "text/plain", "fine")));
    expect(parsed.attachments.map((entry) => entry.filename)).toEqual(["ok.txt"]);
    expect(parsed.skipped).toEqual([expect.stringContaining("big.bin")]);
  });

  it("keeps at most a set number of attachments and names the rest", () => {
    const many = Array.from({ length: MAX_ATTACHMENTS + 2 }, (_unused, index) => file(`f${index}.txt`, "text/plain", "x")).join("");
    const parsed = parseMail(mail(many));
    expect(parsed.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(parsed.skipped).toHaveLength(2);
  });
});

describe("which conversation a message belongs to (D132)", () => {
  const withHeaders = (headers: string): Buffer => Buffer.from(`From: a@b.co\r\nSubject: s\r\nMessage-ID: <m9@x>\r\n${headers}\r\nreply\r\n`);

  it("uses the first message of the References chain, so the third reply stays in the thread", () => {
    expect(parseMail(withHeaders("In-Reply-To: <m3@x>\r\nReferences: <m1@x> <m2@x> <m3@x>\r\n")).thread_root).toBe("<m1@x>");
  });

  it("falls back to In-Reply-To, then to its own id", () => {
    expect(parseMail(withHeaders("In-Reply-To: <m3@x>\r\n")).thread_root).toBe("<m3@x>");
    expect(parseMail(withHeaders("")).thread_root).toBe("<m9@x>");
  });
});
