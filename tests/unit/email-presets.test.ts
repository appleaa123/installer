import { describe, expect, it } from "vitest";
import { explainMailFailure, normalizePassword, presetFor, setupFromPreset } from "../../src/core/email-presets.js";

describe("presetFor (D127)", () => {
  it.each([
    ["me@gmail.com", "Gmail", "imap.gmail.com", "smtp.gmail.com"],
    ["Me@GoogleMail.com", "Gmail", "imap.gmail.com", "smtp.gmail.com"],
    ["me@icloud.com", "iCloud Mail", "imap.mail.me.com", "smtp.mail.me.com"],
    ["me@yahoo.com", "Yahoo Mail", "imap.mail.yahoo.com", "smtp.mail.yahoo.com"],
    ["me@fastmail.com", "Fastmail", "imap.fastmail.com", "smtp.fastmail.com"],
    ["me@zoho.com", "Zoho Mail", "imap.zoho.com", "smtp.zoho.com"],
  ])("maps %s to %s, case-insensitively", (address, name, imapHost, smtpHost) => {
    const result = presetFor(address);
    expect(result.kind).toBe("preset");
    if (result.kind !== "preset") return;
    expect(result.preset.name).toBe(name);
    expect(result.preset.imap.host).toBe(imapHost);
    expect(result.preset.smtp.host).toBe(smtpHost);
  });

  it.each(["me@outlook.com", "me@hotmail.com", "me@live.com", "me@msn.com", "me@proton.me", "me@protonmail.com"])("marks %s as unsupported with a plain reason that offers Telegram", (address) => {
    const result = presetFor(address);
    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") expect(result.reason).toContain("Telegram");
  });

  it("returns unknown for a domain it does not recognise", () => {
    expect(presetFor("me@acme-corp.example")).toEqual({ kind: "unknown", domain: "acme-corp.example" });
  });

  it("returns unknown, not a crash, for text that is not an address", () => {
    expect(presetFor("not an address")).toEqual({ kind: "unknown", domain: "" });
  });

  it("gives every preset an app-password link and numbered plain steps", () => {
    for (const address of ["a@gmail.com", "a@icloud.com", "a@yahoo.com", "a@fastmail.com", "a@zoho.com", "a@aol.com"]) {
      const result = presetFor(address);
      if (result.kind !== "preset") throw new Error(`${address} has no preset`);
      expect(result.preset.help.link).toMatch(/^https:\/\//);
      expect(result.preset.help.steps.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("setupFromPreset", () => {
  it("builds the channel setup: the address signs in to both servers (Gmail)", () => {
    const result = presetFor("me@gmail.com");
    if (result.kind !== "preset") throw new Error("expected a preset");
    expect(setupFromPreset("me@gmail.com", result.preset)).toEqual({
      channel: "email", address: "me@gmail.com",
      imap: { host: "imap.gmail.com", port: 993, security: "ssl", user: "me@gmail.com" },
      smtp: { host: "smtp.gmail.com", port: 465, security: "ssl", user: "me@gmail.com" },
    });
  });

  it("iCloud: IMAP signs in with the part before @, SMTP with the full address, on port 587 with STARTTLS", () => {
    const result = presetFor("Jo@iCloud.com");
    if (result.kind !== "preset") throw new Error("expected a preset");
    expect(setupFromPreset("jo@icloud.com", result.preset)).toMatchObject({
      imap: { host: "imap.mail.me.com", port: 993, security: "ssl", user: "jo" },
      smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", user: "jo@icloud.com" },
    });
  });
});

describe("normalizePassword", () => {
  it("removes the spaces Google shows inside an app password, only for Gmail", () => {
    const gmail = presetFor("me@gmail.com");
    const icloud = presetFor("me@icloud.com");
    if (gmail.kind !== "preset" || icloud.kind !== "preset") throw new Error("expected presets");
    expect(normalizePassword("abcd efgh ijkl mnop", gmail.preset)).toBe("abcdefghijklmnop");
    expect(normalizePassword("abcd-efgh-ijkl-mnop", icloud.preset)).toBe("abcd-efgh-ijkl-mnop");
    expect(normalizePassword("abcd efgh", undefined)).toBe("abcd efgh");
  });
});

describe("explainMailFailure", () => {
  const gmail = presetFor("me@gmail.com");
  const zoho = presetFor("me@zoho.com");
  if (gmail.kind !== "preset" || zoho.kind !== "preset") throw new Error("expected presets");

  it("turns a refused sign-in into advice about the app password, with the provider's own hint", () => {
    const text = explainMailFailure("The mail server imap.gmail.com refused the sign-in for me@gmail.com (NO): check the user and the app password, then run 'taskfollow secret email' again", gmail.preset);
    expect(text).toContain("app password");
    expect(text).toContain("2-Step Verification");
    expect(text).not.toContain("taskfollow secret email");
  });

  it("tells a Zoho person to switch IMAP access on", () => {
    expect(explainMailFailure("The mail server smtp.zoho.com refused the sign-in for me@zoho.com (535): check the user and the app password", zoho.preset)).toContain("IMAP");
  });

  it.each([
    ["Cannot reach the mail server imap.example.com:993 (ECONNREFUSED)", "internet"],
    ["The TLS certificate of imap.example.com is not trusted (SELF_SIGNED_CERT_IN_CHAIN)", "network"],
    ["The mail server smtp.example.com:587 does not offer STARTTLS; use its SSL port instead", "SSL"],
    ["The mail server imap.example.com did not greet as IMAP (garbage)", "port"],
  ])("explains %s", (message, word) => {
    expect(explainMailFailure(message, undefined)).toContain(word);
  });

  it("never echoes a password", () => {
    expect(explainMailFailure("The mail server x refused the sign-in for a@b.c (535) hunter2", undefined)).not.toContain("hunter2");
  });

  it("has a safe fallback for an answer it does not know", () => {
    expect(explainMailFailure("something odd", undefined)).toMatch(/could not|couldn't/i);
  });
});
