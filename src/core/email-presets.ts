import type { EmailConfig } from "./channels.js";
import type { MailSecurity } from "./wire.js";

/**
 * What the email setup page knows about common mail providers (D127): their servers, how to make an app password,
 * and what to say when a sign-in is refused. The servers come from this table or from what the person types on the
 * page, never from the agent: whoever picks the servers picks where the app password goes (D73, D77).
 *
 * Hosts were read from each provider's own help pages on 2026-10-14. Not yet tried against a real mailbox: AOL,
 * the iCloud IMAP user name, and whether Google Workspace accounts still allow app passwords.
 */
export interface PresetAccount {
  readonly host: string;
  readonly port: number;
  readonly security: MailSecurity;
  /** Which name signs in: the whole address, or the part before the @. */
  readonly user: "address" | "local";
}

export interface Preset {
  readonly name: string;
  readonly imap: PresetAccount;
  readonly smtp: PresetAccount;
  /** Google shows its app password in groups separated by spaces; they are not part of the password. */
  readonly stripSpaces: boolean;
  readonly help: { readonly link: string; readonly steps: readonly string[]; readonly missing: string };
  /** Said after a refused sign-in, on top of the general advice. */
  readonly signinHint: string;
}

export type PresetResult =
  | { readonly kind: "preset"; readonly preset: Preset }
  | { readonly kind: "unsupported"; readonly name: string; readonly reason: string }
  | { readonly kind: "unknown"; readonly domain: string };

const ssl = (host: string, port: number, user: PresetAccount["user"] = "address"): PresetAccount => ({ host, port, security: "ssl", user });

const GMAIL: Preset = {
  name: "Gmail", imap: ssl("imap.gmail.com", 993), smtp: ssl("smtp.gmail.com", 465), stripSpaces: true,
  help: {
    link: "https://myaccount.google.com/apppasswords",
    steps: [
      "Make sure 2-Step Verification is turned on for this Google account (Google Account, then Security).",
      "Open https://myaccount.google.com/apppasswords and sign in if asked.",
      "Type a name such as TaskFollow and press Create.",
      "Google shows a password of 16 letters. Copy it (the spaces do not matter) and paste it below.",
    ],
    missing: "If you do not see App passwords, 2-Step Verification is off, or this is a work or school account: ask the administrator whether app passwords are allowed.",
  },
  signinHint: "Check that 2-Step Verification is on, and that you pasted the 16-letter app password and not your normal Google password. For a work or school account, ask the administrator whether app passwords are allowed.",
};

const ICLOUD: Preset = {
  name: "iCloud Mail", imap: ssl("imap.mail.me.com", 993, "local"), smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls", user: "address" }, stripSpaces: false,
  help: {
    link: "https://account.apple.com/",
    steps: [
      "Make sure two-factor authentication is on for this Apple Account.",
      "Sign in at https://account.apple.com/, open Sign-In and Security, then App-Specific Passwords.",
      "Press the + button, name it TaskFollow and press Create.",
      "Copy the password Apple shows (keep the dashes) and paste it below.",
    ],
    missing: "If you do not see App-Specific Passwords, two-factor authentication is not on yet.",
  },
  signinHint: "Check that you pasted an app-specific password from account.apple.com, with its dashes, and not your Apple Account password.",
};

const YAHOO: Preset = {
  name: "Yahoo Mail", imap: ssl("imap.mail.yahoo.com", 993), smtp: ssl("smtp.mail.yahoo.com", 465), stripSpaces: false,
  help: {
    link: "https://login.yahoo.com/account/security",
    steps: [
      "Sign in at https://login.yahoo.com/account/security.",
      "Turn on two-step verification if Yahoo asks you to.",
      "Choose Generate app password (or Manage app passwords), name it TaskFollow and press Generate.",
      "Copy the password Yahoo shows and paste it below.",
    ],
    missing: "If you do not see app passwords, turn on two-step verification first.",
  },
  signinHint: "Check that you pasted a Yahoo app password and not your normal Yahoo password.",
};

const AOL: Preset = {
  ...YAHOO, name: "AOL Mail", imap: ssl("imap.aol.com", 993), smtp: ssl("smtp.aol.com", 465),
  help: { ...YAHOO.help, link: "https://login.aol.com/account/security", steps: YAHOO.help.steps.map((step) => step.replace("login.yahoo.com", "login.aol.com").replace("Yahoo", "AOL")) },
  signinHint: "Check that you pasted an AOL app password and not your normal AOL password.",
};

const FASTMAIL: Preset = {
  name: "Fastmail", imap: ssl("imap.fastmail.com", 993), smtp: ssl("smtp.fastmail.com", 465), stripSpaces: false,
  help: {
    link: "https://app.fastmail.com/settings/security/devicekeys",
    steps: [
      "Sign in to Fastmail and open Settings, then Privacy & Security.",
      "Open App passwords (also called Integrations or Devices), and choose New app password.",
      "Name it TaskFollow, allow Mail (IMAP/SMTP) access and press Generate.",
      "Copy the password Fastmail shows and paste it below.",
    ],
    missing: "Fastmail only accepts an app password here, never the normal password.",
  },
  signinHint: "Check that you pasted a Fastmail app password with mail access.",
};

const ZOHO: Preset = {
  name: "Zoho Mail", imap: ssl("imap.zoho.com", 993), smtp: ssl("smtp.zoho.com", 465), stripSpaces: false,
  help: {
    link: "https://accounts.zoho.com/home#security/app_password",
    steps: [
      "In Zoho Mail open Settings, then Mail Accounts, then IMAP Access, and turn IMAP access on.",
      "Open https://accounts.zoho.com/home#security/app_password.",
      "Generate a new app password named TaskFollow.",
      "Copy the password Zoho shows and paste it below.",
    ],
    missing: "Some free Zoho plans have no IMAP access: if the setting is missing, this mailbox cannot be connected.",
  },
  signinHint: "Check that IMAP access is turned on in the Zoho Mail settings and that you pasted a Zoho app password. Some free Zoho plans do not offer IMAP.",
};

const BY_DOMAIN: Readonly<Record<string, Preset>> = {
  "gmail.com": GMAIL, "googlemail.com": GMAIL,
  "icloud.com": ICLOUD, "me.com": ICLOUD, "mac.com": ICLOUD,
  "yahoo.com": YAHOO, "ymail.com": YAHOO, "rocketmail.com": YAHOO, "yahoo.co.uk": YAHOO, "yahoo.ca": YAHOO,
  "aol.com": AOL,
  "fastmail.com": FASTMAIL, "fastmail.fm": FASTMAIL,
  "zoho.com": ZOHO, "zohomail.com": ZOHO,
};

const NO_PASSWORD_SIGN_IN = "TaskFollow can't connect to this mailbox. Use a mailbox at Gmail, iCloud, Yahoo, Fastmail or Zoho, or choose Telegram as your team channel instead.";
const UNSUPPORTED: Readonly<Record<string, { readonly name: string; readonly reason: string }>> = Object.fromEntries([
  ...["outlook.com", "hotmail.com", "live.com", "msn.com"].map((domain) => [domain, { name: "Outlook / Hotmail", reason: `Microsoft no longer lets other programs sign in to Outlook and Hotmail mailboxes with a password. ${NO_PASSWORD_SIGN_IN}` }]),
  ...["proton.me", "protonmail.com", "pm.me"].map((domain) => [domain, { name: "Proton Mail", reason: `Proton Mail only works with its own Bridge program. ${NO_PASSWORD_SIGN_IN}` }]),
]);

const ADDRESS = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

export function presetFor(address: string): PresetResult {
  const match = ADDRESS.exec(address.trim().toLowerCase());
  const domain = match?.[1] ?? "";
  const preset = BY_DOMAIN[domain];
  if (preset) return { kind: "preset", preset };
  const unsupported = UNSUPPORTED[domain];
  if (unsupported) return { kind: "unsupported", ...unsupported };
  return { kind: "unknown", domain };
}

/** The channel setup a preset gives for this address. */
export function setupFromPreset(address: string, preset: Preset): Omit<EmailConfig, "verified_at"> {
  const normal = address.trim().toLowerCase();
  const user = (account: PresetAccount): string => (account.user === "local" ? normal.split("@")[0] ?? normal : normal);
  const build = (account: PresetAccount) => ({ host: account.host, port: account.port, security: account.security, user: user(account) });
  return { channel: "email", address: normal, imap: build(preset.imap), smtp: build(preset.smtp) };
}

export function normalizePassword(password: string, preset: Preset | undefined): string {
  return preset?.stripSpaces ? password.replace(/\s+/g, "") : password;
}

const GENERAL_SIGNIN = "The mail server did not accept the sign-in. Make sure you entered an app password, not your normal password.";

/** A refusal from the mail code in words a person can act on; it never repeats the server's text, so a password can never come back. */
export function explainMailFailure(message: string, preset: Preset | undefined): string {
  if (/refused the sign-in|check the user and the app password|refused LOGIN/i.test(message)) return `${GENERAL_SIGNIN}${preset ? ` ${preset.signinHint}` : ""}`;
  if (/is not trusted/i.test(message)) return "This network is not letting TaskFollow connect safely to the mail server (its security certificate is not trusted). Try a different network, such as your home internet.";
  if (/Cannot reach/i.test(message)) return "TaskFollow could not reach the mail server. Check your internet connection. On a work network a firewall may block mail: try another network. If you changed the server under Advanced, check it.";
  if (/does not offer STARTTLS/i.test(message)) return "That mail server port needs a different setting. Open Advanced and choose the SSL option, or use the provider's SSL port.";
  if (/did not greet as IMAP/i.test(message)) return "Something answered, but it is not a mail server on that port. Check the port number under Advanced.";
  return "TaskFollow could not connect to this mailbox. Check the address and the app password, and open Advanced to check the server settings.";
}
