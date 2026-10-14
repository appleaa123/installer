import { describe, expect, it } from "vitest";
import { parseMail } from "../../src/core/mime.js";
import { buildMessage, type MailMessage } from "../../src/core/smtp.js";

const BASE: MailMessage = { from: "desk@example.com", to: "ada@example.com", subject: "Quote", text: "Please see the attached.", message_id: "<q1@example.com>", date: "2026-10-14T12:00:00.000Z" };
const roundTrip = (message: MailMessage) => parseMail(Buffer.from(buildMessage(message), "latin1"));

describe("a message with attachments (D133)", () => {
  it("is a multipart message that reads back as the same text and the same bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 13, 10, 46, 13, 10]);
    const parsed = roundTrip({ ...BASE, attachments: [{ filename: "quote.pdf", type: "application/pdf", bytes }] });
    expect(parsed.text).toBe("Please see the attached.");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({ filename: "quote.pdf", type: "application/pdf" });
    expect(parsed.attachments[0]?.bytes.equals(bytes)).toBe(true);
  });

  it("carries several files in order", () => {
    const parsed = roundTrip({ ...BASE, attachments: [{ filename: "a.txt", type: "text/plain", bytes: Buffer.from("one") }, { filename: "b.csv", type: "text/csv", bytes: Buffer.from("x,y") }] });
    expect(parsed.attachments.map((entry) => entry.filename)).toEqual(["a.txt", "b.csv"]);
  });

  it("keeps a name with accents or spaces", () => {
    const parsed = roundTrip({ ...BASE, attachments: [{ filename: "résumé final.txt", type: "text/plain", bytes: Buffer.from("x") }] });
    expect(parsed.attachments[0]?.filename).toBe("résumé final.txt");
  });

  it("wraps every line at 76 characters and cannot start a line with a dot (nothing to dot-stuff)", () => {
    const raw = buildMessage({ ...BASE, attachments: [{ filename: "big.bin", type: "application/octet-stream", bytes: Buffer.alloc(5000, 0x2e) }] });
    for (const line of raw.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(raw.split("\r\n").filter((line) => line.startsWith("."))).toEqual([]);
  });

  it("stays a plain single-part message when there are no attachments", () => {
    const raw = buildMessage(BASE);
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).not.toContain("multipart");
    expect(roundTrip(BASE).attachments).toEqual([]);
  });

  it("never uses a boundary that appears in the file", () => {
    const raw = buildMessage({ ...BASE, attachments: [{ filename: "x.txt", type: "text/plain", bytes: Buffer.from("--BOUNDARY-LOOKALIKE--") }] });
    const boundary = /boundary="([^"]+)"/.exec(raw)?.[1] ?? "";
    expect(boundary.length).toBeGreaterThan(20);
    expect(Buffer.from("--BOUNDARY-LOOKALIKE--").toString("base64")).not.toContain(boundary);
  });
});
