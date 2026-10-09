/**
 * Opt-in live test of the email channel's protocols (D48, D75): `npm run test:live` with
 *   TEST_EMAIL_ADDRESS, TEST_EMAIL_APP_PASSWORD,
 *   TEST_EMAIL_IMAP_HOST, TEST_EMAIL_IMAP_PORT, TEST_EMAIL_IMAP_SECURITY (ssl | starttls), TEST_EMAIL_IMAP_USER,
 *   TEST_EMAIL_SMTP_HOST, TEST_EMAIL_SMTP_PORT, TEST_EMAIL_SMTP_SECURITY (ssl | starttls), TEST_EMAIL_SMTP_USER
 * in the environment; everything is skipped when any of them is empty. It signs in to IMAP and opens INBOX
 * read-only (EXAMINE: nothing is marked read or moved), and it sends ONE real email from the test mailbox to
 * the same address (TEST_EMAIL_ADDRESS), so it arrives in the developer's own mailbox.
 */
import { describe, expect, it } from "vitest";
import { withImap } from "../../src/core/imap.js";
import { smtpSend, type MailAccount } from "../../src/core/smtp.js";
import type { MailSecurity } from "../../src/core/wire.js";

const env = (name: string): string => process.env[name] ?? "";
const NAMES = ["ADDRESS", "APP_PASSWORD", "IMAP_HOST", "IMAP_PORT", "IMAP_SECURITY", "IMAP_USER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURITY", "SMTP_USER"];
const missing = NAMES.some((name) => env(`TEST_EMAIL_${name}`) === "");
const account = (kind: "IMAP" | "SMTP"): MailAccount => ({
  host: env(`TEST_EMAIL_${kind}_HOST`), port: Number(env(`TEST_EMAIL_${kind}_PORT`)), security: env(`TEST_EMAIL_${kind}_SECURITY`) as MailSecurity, user: env(`TEST_EMAIL_${kind}_USER`),
});
/** No test certificate, whatever the shell has set: the live test checks the provider's real one. */
const NO_OVERRIDE = {};

describe.skipIf(missing)("real mailbox (D75)", () => {
  it("signs in to IMAP with LOGIN and opens INBOX read-only", async () => {
    const status = await withImap(account("IMAP"), env("TEST_EMAIL_APP_PASSWORD"), (session) => session.examine("INBOX"), NO_OVERRIDE);
    expect(status.uidvalidity).toBeGreaterThan(0);
    expect(status.uidnext).toBeGreaterThan(0);
  });

  it("sends one email to the test mailbox itself with AUTH PLAIN", async () => {
    const address = env("TEST_EMAIL_ADDRESS");
    const now = new Date().toISOString();
    const message = { from: address, to: address, subject: `installer live test ${now}`, text: "Sent by the installer's live test (Plan 6). You can delete it.", message_id: `<live-${Date.now()}@${address.split("@")[1]}>`, date: now };
    await expect(smtpSend(account("SMTP"), env("TEST_EMAIL_APP_PASSWORD"), message, NO_OVERRIDE)).resolves.toBeUndefined();
  });
});
