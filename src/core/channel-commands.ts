import { appendAudit } from "./audit.js";
import { CHANNEL_FACTS, channelSecret, listChannels, loadChannel, requireChannelId, saveChannel, saveCursor, type ChannelConfig, type ChannelId, type EmailConfig } from "./channels.js";
import { MAILBOX, startCursor } from "./email-channel.js";
import { withImap } from "./imap.js";
import { InputError } from "./inputs.js";
import { deleteSecret, getSecret } from "./keychain.js";
import { smtpVerify, type MailAccount } from "./smtp.js";
import { telegramApi } from "./telegram.js";
import { MAIL_SECURITY, type MailSecurity } from "./wire.js";

/**
 * `taskfollow channel [telegram | email --value <json>]` (D73): checks the channel live at once (Telegram getMe;
 * email IMAP sign-in + EXAMINE and SMTP sign-in, nothing sent) and saves it as verified, or exits 2 with what to
 * fix. Without an id it lists the configured channels. The CHANNELS phase completes through `channel_verified`.
 * The mailbox's servers receive the app password, so only a person chooses them: on the setup page of
 * `taskfollow secret email` (D127), which stores them as `email-settings`, or with `--value` in their own terminal.
 * `channel email` with no `--value` then checks what the page stored, or the saved mailbox again.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const HOST = /^[A-Za-z0-9.-]+$/;
const EMAIL_EXAMPLE = `'{"address":"desk@example.com","imap":{"host":"imap.example.com","port":993,"security":"ssl"},"smtp":{"host":"smtp.example.com","port":465,"security":"ssl"}}'`;

export function requireEmailAddress(value: unknown, what: string): string {
  if (typeof value !== "string" || !EMAIL.test(value.trim())) throw new InputError(`${what} must be an email address`);
  return value.trim().toLowerCase();
}

function account(value: unknown, kind: "imap" | "smtp", address: string): MailAccount {
  if (!isRecord(value)) throw new InputError(`--value needs "${kind}": {"host", "port", "security"}; for example ${EMAIL_EXAMPLE}`);
  const { host, port, security, user } = value;
  if (typeof host !== "string" || !HOST.test(host)) throw new InputError(`${kind}.host must be a host name, for example ${kind}.example.com`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) throw new InputError(`${kind}.port must be a port number, for example ${kind === "imap" ? 993 : 465}`);
  if (!(MAIL_SECURITY as readonly unknown[]).includes(security)) throw new InputError(`${kind}.security must be one of ${MAIL_SECURITY.join(", ")} (ssl: TLS from the start, ports 993 and 465; starttls: ports 143 and 587)`);
  if (user !== undefined && (typeof user !== "string" || user.trim() === "")) throw new InputError(`${kind}.user must be the sign-in name; leave it out to use the address`);
  return { host, port, security: security as MailSecurity, user: typeof user === "string" ? user.trim() : address };
}

export function parseEmailSetup(value: string | undefined): Omit<EmailConfig, "verified_at"> {
  if (value === undefined) throw new InputError(`channel email needs --value with the mailbox's servers, for example ${EMAIL_EXAMPLE}`);
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new InputError(`--value must be JSON, for example ${EMAIL_EXAMPLE}`);
  }
  if (!isRecord(raw)) throw new InputError(`--value must be a JSON object, for example ${EMAIL_EXAMPLE}`);
  const address = requireEmailAddress(raw.address, "address");
  return { channel: "email", address, imap: account(raw.imap, "imap", address), smtp: account(raw.smtp, "smtp", address) };
}

async function verifyTelegram(now: string, env: Env): Promise<ChannelConfig> {
  const bot = await telegramApi(await channelSecret("telegram", env), env).getMe();
  return { channel: "telegram", bot, verified_at: now };
}

/** The item the email setup page leaves for this command: the servers the person chose in their own browser. */
export const EMAIL_HANDOFF = "email-settings";

async function emailHandoff(home: string, env: Env): Promise<{ readonly value: string; readonly fromPage: boolean }> {
  const stored = await getSecret(EMAIL_HANDOFF, env);
  if (stored !== null) return { value: stored, fromPage: true };
  const saved = await loadChannel(home, "email");
  if (saved?.channel === "email") return { value: JSON.stringify({ address: saved.address, imap: saved.imap, smtp: saved.smtp }), fromPage: false };
  throw new InputError("The mailbox is not set up yet: run 'taskfollow secret email', let the person finish the page that opens, then run 'taskfollow channel email' again");
}

async function verifyEmail(home: string, value: string | undefined, now: string, env: Env): Promise<ChannelConfig> {
  const setup = parseEmailSetup(value);
  const password = await channelSecret("email", env);
  const status = await withImap(setup.imap, password, (session) => session.examine(MAILBOX), env);
  await smtpVerify(setup.smtp, password, env);
  await saveCursor(home, "email", startCursor(status));
  return { ...setup, verified_at: now };
}

/** `doctor` (§16.1, D103): the channel still answers with its stored secret; nothing is sent and nothing is saved. */
export async function checkChannel(config: ChannelConfig, env: Env = process.env): Promise<string> {
  const secret = await channelSecret(config.channel, env);
  if (config.channel === "telegram") return `@${(await telegramApi(secret, env).getMe()).username} answers`;
  await withImap(config.imap, secret, (session) => session.examine(MAILBOX), env);
  await smtpVerify(config.smtp, secret, env);
  return "IMAP and SMTP sign-in work";
}

/** A channel as the person and the agent see it: never its secret. */
export const describeChannel = (config: ChannelConfig) => ({
  channel: config.channel, verified_at: config.verified_at, ...CHANNEL_FACTS[config.channel],
  ...(config.channel === "telegram" ? { bot: `@${config.bot.username}` } : { address: config.address }),
});

/** The mailbox's servers decide where the app password goes, so like `invite` (D77) only a person at a terminal sets them. */
async function requireTerminal(home: string, interactive: boolean, now: string): Promise<void> {
  if (interactive) return;
  await appendAudit(home, { ts: now, actor: "agent", event: "channel.refused", ref: "email", payload: { command: "taskfollow channel email" } });
  throw new InputError("The mailbox's servers are set by a person in their own terminal, not by the agent: let the person use the page that 'taskfollow secret email' opens, which asks for the address and the app password only");
}

export async function channelCommand(home: string, id: string | undefined, value: string | undefined, now: () => string, env: Env = process.env, interactive = false): Promise<unknown> {
  if (id === undefined) return { channels: (await listChannels(home)).map(describeChannel) };
  const channel: ChannelId = requireChannelId(id);
  if (channel === "telegram" && value !== undefined) throw new InputError("channel telegram takes no --value: it reads the bot token stored with 'taskfollow secret telegram'");
  if (channel === "email" && value !== undefined) await requireTerminal(home, interactive, now());
  const handoff = channel === "email" && value === undefined ? await emailHandoff(home, env) : undefined;
  const config = channel === "telegram" ? await verifyTelegram(now(), env) : await verifyEmail(home, value ?? handoff?.value, now(), env);
  await saveChannel(home, config);
  if (handoff?.fromPage) await deleteSecret(EMAIL_HANDOFF, env);
  await appendAudit(home, { ts: now(), actor: "agent", event: "channel.verified", ref: channel, payload: describeChannel(config) });
  return { status: "verified", ...describeChannel(config), next: "Run 'taskfollow invite <name>' in a terminal for each person who will approve from this channel" };
}
