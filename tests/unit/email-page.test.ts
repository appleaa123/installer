import { afterEach, describe, expect, it } from "vitest";
import { startEmailPage } from "../../src/core/email-page.js";
import type { EmailConfig } from "../../src/core/channels.js";
import { ActionFailure } from "../../src/core/failure.js";
import type { SecretPage } from "../../src/core/secret-page.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, startFakeSmtp, type FakeImap, type FakeSmtp } from "../helpers/fake-mail.js";
import { formHeaders, request } from "../helpers/http.js";

type Setup = Omit<EmailConfig, "verified_at">;
const pages: SecretPage[] = [];
const stopFakes: (() => Promise<void>)[] = [];

afterEach(async () => {
  pages.splice(0).forEach((open) => open.close());
  await Promise.all(stopFakes.splice(0).map((stop) => stop()));
});

interface Recorder {
  readonly stored: [string, string][];
  readonly checked: { setup: Setup; password: string }[];
}

async function page(check?: (setup: Setup, password: string) => Promise<void>, ttlMs?: number): Promise<{ url: string; origin: string; rec: Recorder; done: SecretPage["done"] }> {
  const rec: Recorder = { stored: [], checked: [] };
  const started = await startEmailPage({
    store: async (id, value) => void rec.stored.push([id, value]),
    check: async (setup, password) => {
      rec.checked.push({ setup, password });
      await check?.(setup, password);
    },
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  pages.push(started);
  return { url: started.url, origin: new URL(started.url).origin, rec, done: started.done };
}

const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();
const post = (url: string, fields: Record<string, string>) => request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: form(fields) });
const GMAIL_FIELDS = {
  step: "connect", address: "me@gmail.com", password: "abcd efgh ijkl mnop",
  imap_host: "imap.gmail.com", imap_port: "993", imap_security: "ssl", imap_user: "me@gmail.com",
  smtp_host: "smtp.gmail.com", smtp_port: "465", smtp_security: "ssl", smtp_user: "me@gmail.com",
};

describe("the email setup page (D127)", () => {
  it("step 1 asks only for the address, on a one-time path", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('name="address"');
    expect(reply.text).not.toContain('name="password"');
    expect(reply.text).not.toContain("imap_host");
  });

  it("step 2 for a known provider shows its app-password steps and a password box, with the servers prefilled but folded away", async () => {
    const { url } = await page();
    const reply = await post(url, { step: "address", address: "Me@Gmail.com" });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Gmail");
    expect(reply.text).toContain("myaccount.google.com/apppasswords");
    expect(reply.text).toContain('<input type="password" name="password"');
    expect(reply.text).toContain('value="imap.gmail.com"');
    expect(reply.text).toMatch(/<details>/);
    expect(reply.text).not.toMatch(/<details open/);
  });

  it("step 2 for Outlook says why it cannot connect, offers Telegram, and has no password box", async () => {
    const { url } = await page();
    const reply = await post(url, { step: "address", address: "me@outlook.com" });
    expect(reply.text).toContain("Microsoft");
    expect(reply.text).toContain("Telegram");
    expect(reply.text).not.toContain('name="password"');
  });

  it("step 2 for an unknown domain opens Advanced with a guess and a warning to use the provider's own values", async () => {
    const { url } = await page();
    const reply = await post(url, { step: "address", address: "me@acme-corp.example" });
    expect(reply.text).toMatch(/<details open>/);
    expect(reply.text).toContain('value="imap.acme-corp.example"');
    expect(reply.text).toContain("provider");
    expect(reply.text).toContain('name="password"');
  });

  it("asks again, politely, when the address is not an address", async () => {
    const { url } = await page();
    const reply = await post(url, { step: "address", address: "not an address" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("email address");
    expect(reply.text).toContain('name="address"');
  });

  it("a passing check stores the password, then the servers, and says Connected", async () => {
    const { url, rec, done } = await page();
    const reply = await post(url, GMAIL_FIELDS);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Connected");
    expect(rec.stored.map(([id]) => id)).toEqual(["email", "email-settings"]);
    expect(rec.stored[0]?.[1]).toBe("abcdefghijklmnop");
    expect(JSON.parse(rec.stored[1]?.[1] ?? "{}")).toMatchObject({ channel: "email", address: "me@gmail.com", imap: { host: "imap.gmail.com", port: 993 }, smtp: { host: "smtp.gmail.com", port: 465 } });
    await expect(done).resolves.toBe("stored");
  });

  it("removes the spaces Google shows in an app password before testing and storing it", async () => {
    const { url, rec } = await page();
    await post(url, GMAIL_FIELDS);
    expect(rec.checked[0]?.password).toBe("abcdefghijklmnop");
  });

  it("a failing check stores nothing, explains in plain words, keeps the address, and never echoes the password", async () => {
    const { url, rec } = await page(async () => {
      throw new ActionFailure("The mail server imap.gmail.com refused the sign-in for me@gmail.com (NO): check the user and the app password, then run 'taskfollow secret email' again");
    });
    const reply = await post(url, { ...GMAIL_FIELDS, password: "super-secret-pass" });
    expect(reply.status).toBe(400);
    expect(rec.stored).toEqual([]);
    expect(reply.text).toContain("app password");
    expect(reply.text).toContain("2-Step Verification");
    expect(reply.text).toContain('value="me@gmail.com"');
    expect(reply.text).not.toContain("super-secret-pass");
    expect(reply.text).not.toContain("taskfollow secret email");
    expect((await post(url, GMAIL_FIELDS)).status).toBe(400);
  });

  it("uses the servers the person typed, taking nothing from earlier requests", async () => {
    const { url, rec } = await page();
    await post(url, { step: "address", address: "me@gmail.com" });
    await post(url, { ...GMAIL_FIELDS, imap_host: "imap.mine.example", imap_port: "143", imap_security: "starttls" });
    expect(rec.checked[0]?.setup.imap).toEqual({ host: "imap.mine.example", port: 143, security: "starttls", user: "me@gmail.com" });
    expect(rec.checked[0]?.setup.smtp.host).toBe("smtp.gmail.com");
  });

  it("refuses servers that are not valid, and tests nothing", async () => {
    const { url, rec } = await page();
    const reply = await post(url, { ...GMAIL_FIELDS, imap_host: "bad host!", imap_port: "99999" });
    expect(reply.status).toBe(400);
    expect(rec.checked).toEqual([]);
  });

  it("refuses an empty password without testing", async () => {
    const { url, rec } = await page();
    const reply = await post(url, { ...GMAIL_FIELDS, password: "  " });
    expect(reply.status).toBe(400);
    expect(rec.checked).toEqual([]);
  });

  describe("security", () => {
    it("refuses a wrong Host header, an unknown path, and a POST from another origin", async () => {
      const { url } = await page();
      expect((await request(url, { headers: { Host: "evil.example" } })).status).toBe(403);
      expect((await request(`${new URL(url).origin}/s/${"0".repeat(64)}`)).status).toBe(404);
      const crossOrigin = await request(url, { method: "POST", headers: formHeaders("http://evil.example"), body: form(GMAIL_FIELDS) });
      expect(crossOrigin.status).toBe(403);
    });

    it("sends a content security policy that allows no scripts and posts only to itself", async () => {
      const { url } = await page();
      const res = await fetch(url);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("content-security-policy")).toContain("form-action 'self'");
    });

    it("expires after its time limit", async () => {
      const { done } = await page(undefined, 50);
      await expect(done).resolves.toBe("expired");
    });
  });
});

describe("the email setup page against real servers (fake IMAP and SMTP)", () => {
  async function servers(): Promise<{ imap: FakeImap; smtp: FakeSmtp }> {
    const imap = await startFakeImap("ssl");
    const smtp = await startFakeSmtp("ssl");
    stopFakes.push(imap.stop, smtp.stop);
    return { imap, smtp };
  }

  async function realPage(): Promise<{ url: string; stored: [string, string][] }> {
    const stored: [string, string][] = [];
    const started = await startEmailPage({ store: async (id, value) => void stored.push([id, value]), env: TEST_TLS_ENV });
    pages.push(started);
    return { url: started.url, stored };
  }

  const fields = (imap: FakeImap, smtp: FakeSmtp, password: string): Record<string, string> => ({
    step: "connect", address: MAIL_USER, password,
    imap_host: "127.0.0.1", imap_port: String(imap.port), imap_security: "ssl", imap_user: MAIL_USER,
    smtp_host: "127.0.0.1", smtp_port: String(smtp.port), smtp_security: "ssl", smtp_user: MAIL_USER,
  });

  it("connects and stores when both servers accept the sign-in", async () => {
    const { imap, smtp } = await servers();
    const { url, stored } = await realPage();
    const reply = await post(url, fields(imap, smtp, MAIL_PASSWORD));
    expect(reply.text).toContain("Connected");
    expect(stored.map(([id]) => id)).toEqual(["email", "email-settings"]);
  });

  it("explains a wrong password in plain words and stores nothing", async () => {
    const { imap, smtp } = await servers();
    const { url, stored } = await realPage();
    const reply = await post(url, fields(imap, smtp, "wrong password"));
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("app password");
    expect(stored).toEqual([]);
  });

  it("explains a server that cannot be reached", async () => {
    const { imap, smtp } = await servers();
    const { url, stored } = await realPage();
    const reply = await post(url, { ...fields(imap, smtp, MAIL_PASSWORD), imap_port: "9" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("internet");
    expect(stored).toEqual([]);
  });
});
