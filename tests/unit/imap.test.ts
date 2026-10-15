import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { quoted, withImap } from "../../src/core/imap.js";
import { InputError } from "../../src/core/inputs.js";
import { parseMail } from "../../src/core/mime.js";
import type { MailAccount } from "../../src/core/smtp.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, type FakeImap } from "../helpers/fake-mail.js";

const PLAIN = "From: Ada <Ada@Example.com>\r\nSubject: Hello\r\nMessage-ID: <a1@example.com>\r\n\r\nA42\r\n";
const SECOND = "From: grace@example.com\r\nSubject: Again\r\nMessage-ID: <g1@example.com>\r\n\r\nR42 not now\r\n";
let fake: FakeImap | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

const account = (server: FakeImap, security: "ssl" | "starttls"): MailAccount => ({ host: "127.0.0.1", port: server.port, security, user: MAIL_USER });

describe("IMAP, read-only (D75)", () => {
  it("signs in with quoted strings over SSL and opens INBOX read-only", async () => {
    fake = await startFakeImap("ssl", [PLAIN]);
    const status = await withImap(account(fake, "ssl"), MAIL_PASSWORD, (session) => session.examine("INBOX"), TEST_TLS_ENV);
    expect(status).toEqual({ uidvalidity: 7, uidnext: 102 });
    expect(fake.logins).toEqual([{ user: MAIL_USER, password: MAIL_PASSWORD, secure: true }]);
  });

  it("upgrades a STARTTLS connection before LOGIN", async () => {
    fake = await startFakeImap("starttls");
    await withImap(account(fake, "starttls"), MAIL_PASSWORD, (session) => session.examine("INBOX"), TEST_TLS_ENV);
    expect(fake.commands.slice(0, 2)).toEqual(["STARTTLS", "LOGIN ***"]);
    expect(fake.logins[0]?.secure).toBe(true);
  });

  it("lists only newer messages, although the server always names the last one, and fetches them whole", async () => {
    fake = await startFakeImap("ssl", [PLAIN, SECOND]);
    const result = await withImap(account(fake, "ssl"), MAIL_PASSWORD, async (session) => {
      await session.examine("INBOX");
      return { none: await session.newerThan(102), one: await session.newerThan(101), both: await session.newerThan(100), raw: (await session.fetch(102)).toString("utf8") };
    }, TEST_TLS_ENV);
    expect(result).toEqual({ none: [], one: [102], both: [101, 102], raw: SECOND });
  });

  it("never changes the mailbox: no SELECT, STORE, EXPUNGE or flag-setting FETCH", async () => {
    fake = await startFakeImap("ssl", [PLAIN]);
    await withImap(account(fake, "ssl"), MAIL_PASSWORD, async (session) => {
      await session.examine("INBOX");
      await session.fetch(101);
    }, TEST_TLS_ENV);
    expect(fake.commands).toEqual(["LOGIN ***", 'EXAMINE "INBOX"', "UID FETCH 101 (BODY.PEEK[])", "LOGOUT"]);
  });

  it("refuses a wrong password with what to do", async () => {
    fake = await startFakeImap("ssl");
    const refused = withImap(account(fake, "ssl"), "wrong", (session) => session.examine("INBOX"), TEST_TLS_ENV);
    await expect(refused).rejects.toThrow(ActionFailure);
    await expect(refused).rejects.toThrow("run 'taskfollow secret email' again");
  });

  it("quotes backslashes and double quotes, and refuses what a quoted string cannot carry", () => {
    expect(quoted('a"b\\c', "user")).toBe('"a\\"b\\\\c"');
    expect(() => quoted("pa\r\nss", "app password")).toThrow(InputError);
    expect(() => quoted("pässword", "app password")).toThrow("printable ASCII");
  });
});

describe("reading a message (MIME)", () => {
  it("reads the sender's address, the subject, the ids and the text", () => {
    const raw = Buffer.from("From: \"Ada L.\" <Ada@Example.com>\r\nSubject: Hello\r\nMessage-ID: <a1@example.com>\r\nIn-Reply-To: <m1@example.com>\r\n\r\nHi there\r\n");
    expect(parseMail(raw)).toEqual({ from: "ada@example.com", subject: "Hello", message_id: "<a1@example.com>", in_reply_to: "<m1@example.com>", thread_root: "<m1@example.com>", text: "Hi there", attachments: [], skipped: [] });
  });

  it("decodes encoded words, base64 and quoted-printable parts in other charsets", () => {
    const raw = [
      "From: =?UTF-8?Q?Andr=C3=A9?= <andre@example.com>", "Subject: =?UTF-8?B?UsOpdW5pb24=?= =?UTF-8?Q?_demain?=", 'Content-Type: multipart/alternative; boundary="b1"', "",
      "--b1", "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable", "", "Caf=E9 =", "ouvert", "--b1",
      "Content-Type: text/html", "", "<p>ignored</p>", "--b1--", "",
    ].join("\r\n");
    expect(parseMail(Buffer.from(raw, "latin1"))).toMatchObject({ from: "andre@example.com", subject: "Réunion demain", text: "Café ouvert" });
    const b64 = `Subject: x\r\nContent-Transfer-Encoding: base64\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${Buffer.from("Grüße").toString("base64")}\r\n`;
    expect(parseMail(Buffer.from(b64)).text).toBe("Grüße");
  });

  it("finds the text inside nested multipart mail and cuts the quoted earlier message", () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="outer"', "", "--outer", 'Content-Type: multipart/alternative; boundary="inner"', "", "--inner",
      "Content-Type: text/plain", "", "A42", "", "On Tue, Oct 6, 2026 at 9:00 AM installer wrote:", "> Approval 42 waits", "--inner--", "--outer--", "",
    ].join("\r\n");
    expect(parseMail(Buffer.from(raw)).text).toBe("A42");
  });

  it("reads the words of HTML-only mail as plain text (D143)", () => {
    expect(parseMail(Buffer.from("Subject: s\r\nContent-Type: text/html\r\n\r\n<b>A42</b>\r\n")).text).toBe("A42");
  });
});
