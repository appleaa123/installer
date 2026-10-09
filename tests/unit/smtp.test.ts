import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { buildMessage, smtpSend, smtpVerify, type MailAccount, type MailMessage } from "../../src/core/smtp.js";
import { tlsOptions } from "../../src/core/wire.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeSmtp, type FakeSmtp } from "../helpers/fake-mail.js";

const MESSAGE: MailMessage = {
  from: MAIL_USER, to: "ada@example.com", subject: "Your request", text: "Hello Ada,\nsee you on Thursday.", message_id: "<m1@example.com>", date: "2026-10-08T12:00:00.000Z",
};
let fake: FakeSmtp | null = null;
afterEach(async () => {
  await fake?.stop();
  fake = null;
});

const account = (server: FakeSmtp, security: "ssl" | "starttls"): MailAccount => ({ host: "127.0.0.1", port: server.port, security, user: MAIL_USER });
const bodyOf = (data: string): string => Buffer.from(data.split("\r\n\r\n")[1] ?? "", "base64").toString("utf8");

describe("SMTP over SSL and STARTTLS (D75)", () => {
  it("signs in over SSL with AUTH PLAIN and leaves without sending", async () => {
    fake = await startFakeSmtp("ssl");
    await smtpVerify(account(fake, "ssl"), MAIL_PASSWORD, TEST_TLS_ENV);
    expect(fake.logins).toEqual([{ user: MAIL_USER, password: MAIL_PASSWORD, secure: true }]);
    expect(fake.received).toEqual([]);
  });

  it("upgrades a STARTTLS connection before it sends the password", async () => {
    fake = await startFakeSmtp("starttls");
    await smtpVerify(account(fake, "starttls"), MAIL_PASSWORD, TEST_TLS_ENV);
    expect(fake.logins).toEqual([{ user: MAIL_USER, password: MAIL_PASSWORD, secure: true }]);
  });

  it("sends one plain-text UTF-8 message with its headers", async () => {
    fake = await startFakeSmtp("ssl");
    await smtpSend(account(fake, "ssl"), MAIL_PASSWORD, { ...MESSAGE, in_reply_to: "<q1@example.com>" }, TEST_TLS_ENV);
    const [mail] = fake.received;
    expect(mail).toMatchObject({ from: MAIL_USER, to: "ada@example.com" });
    expect(mail?.data).toContain("Subject: Your request\r\n");
    expect(mail?.data).toContain("Message-ID: <m1@example.com>\r\nIn-Reply-To: <q1@example.com>\r\n");
    expect(mail?.data).toContain("Date: Thu, 08 Oct 2026 12:00:00 GMT\r\n");
    expect(bodyOf(mail?.data ?? "")).toBe("Hello Ada,\r\nsee you on Thursday.");
  });

  it("refuses a wrong password with what to do, never echoing the password", async () => {
    fake = await startFakeSmtp("ssl");
    const refused = smtpVerify(account(fake, "ssl"), "wrong-secret-9", TEST_TLS_ENV);
    await expect(refused).rejects.toThrow(ActionFailure);
    await expect(refused).rejects.toThrow("run 'installer secret email' again");
    await expect(refused).rejects.not.toThrow("wrong-secret-9");
  });

  it("refuses a STARTTLS port whose server does not offer STARTTLS, before any password is sent", async () => {
    fake = await startFakeSmtp("starttls", { offerStartTls: false });
    await expect(smtpVerify(account(fake, "starttls"), MAIL_PASSWORD, TEST_TLS_ENV)).rejects.toThrow("does not offer STARTTLS");
    expect(fake.logins).toEqual([]);
  });

  it("does not trust a certificate the system does not trust", async () => {
    fake = await startFakeSmtp("ssl");
    await expect(smtpVerify(account(fake, "ssl"), MAIL_PASSWORD, {})).rejects.toThrow("is not trusted");
  });

  it("says when nothing answers", async () => {
    fake = await startFakeSmtp("ssl");
    const port = fake.port;
    await fake.stop();
    fake = null;
    await expect(smtpVerify({ host: "127.0.0.1", port, security: "ssl", user: MAIL_USER }, MAIL_PASSWORD, TEST_TLS_ENV)).rejects.toThrow(`Cannot reach the mail server 127.0.0.1:${port}`);
  });
});

describe("the message and the test certificate override", () => {
  it("encodes a subject that is not ASCII", () => {
    expect(buildMessage({ ...MESSAGE, subject: "Réunion" })).toContain(`Subject: =?UTF-8?B?${Buffer.from("Réunion").toString("base64")}?=\r\n`);
  });

  it.each([["subject", { subject: "Hi\r\nBcc: everyone@example.com" }], ["recipient", { to: "a@example.com\nBcc: b@example.com" }]])("refuses a %s with a line break", (_what, change) => {
    expect(() => buildMessage({ ...MESSAGE, ...change })).toThrow(InputError);
  });

  it("accepts the test certificate for 127.0.0.1 only", () => {
    expect(tlsOptions("127.0.0.1", TEST_TLS_ENV)).toHaveProperty("ca");
    expect(() => tlsOptions("smtp.example.com", TEST_TLS_ENV)).toThrow("only for a test server on 127.0.0.1");
    expect(tlsOptions("smtp.example.com", {})).toEqual({ host: "smtp.example.com", servername: "smtp.example.com" });
  });
});
