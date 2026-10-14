import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { openWire, type Endpoint, type Wire } from "./wire.js";

/**
 * Outbound mail over SMTP (RFC 5321) on the line wire: EHLO, STARTTLS when asked for, AUTH PLAIN (RFC 4616),
 * then one message. AUTH PLAIN sends `\0user\0password` in base64 in one line, which the providers tested so far
 * accept where other clients' AUTH LOGIN exchanges misbehaved. The body is UTF-8 in base64, so no line of it can
 * start with a dot and nothing needs dot-stuffing.
 */
export interface MailAccount extends Endpoint {
  readonly user: string;
}

export interface MailMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly message_id: string;
  readonly date: string;
  readonly in_reply_to?: string;
}

type Env = Readonly<Record<string, string | undefined>>;
const EHLO_NAME = "localhost";

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/** One reply, all its `250-` continuation lines included. */
async function readReply(wire: Wire): Promise<Reply> {
  const lines: string[] = [];
  for (;;) {
    const line = await wire.readLine();
    lines.push(line.slice(4));
    if (line.charAt(3) !== "-") return { code: Number(line.slice(0, 3)), lines };
  }
}

async function command(wire: Wire, line: string | null, expected: readonly number[], what: string, host: string): Promise<Reply> {
  if (line !== null) await wire.write(`${line}\r\n`);
  const reply = await readReply(wire);
  if (!expected.includes(reply.code)) throw new ActionFailure(`The mail server ${host} refused ${what} (${reply.code} ${reply.lines.join(" ").slice(0, 200)})`);
  return reply;
}

async function hello(wire: Wire, account: MailAccount): Promise<void> {
  const ehlo = await command(wire, `EHLO ${EHLO_NAME}`, [250], "EHLO", account.host);
  if (account.security !== "starttls") return;
  if (!ehlo.lines.some((line) => /^STARTTLS\b/i.test(line))) throw new ActionFailure(`The mail server ${account.host}:${account.port} does not offer STARTTLS; use its SSL port instead`);
  await command(wire, "STARTTLS", [220], "STARTTLS", account.host);
  await wire.startTls();
  await command(wire, `EHLO ${EHLO_NAME}`, [250], "EHLO", account.host);
}

async function signIn(wire: Wire, account: MailAccount, password: string): Promise<void> {
  const plain = Buffer.from(`\u0000${account.user}\u0000${password}`, "utf8").toString("base64");
  await wire.write(`AUTH PLAIN ${plain}\r\n`);
  const reply = await readReply(wire);
  if (reply.code === 235) return;
  throw new ActionFailure(`The mail server ${account.host} refused the sign-in for ${account.user} (${reply.code}): check the user and the app password, then run 'taskpilot secret email' again`);
}

/** Opens, greets, signs in, runs `task`, then says QUIT; the connection is always closed. */
async function session<T>(account: MailAccount, password: string, env: Env, task: (wire: Wire) => Promise<T>): Promise<T> {
  const wire = await openWire(account, env);
  try {
    await command(wire, null, [220], "the connection", account.host);
    await hello(wire, account);
    await signIn(wire, account, password);
    const result = await task(wire);
    await command(wire, "QUIT", [221], "QUIT", account.host);
    return result;
  } finally {
    wire.close();
  }
}

/** Signs in and out without sending anything (`taskpilot channel email`). */
export function smtpVerify(account: MailAccount, password: string, env: Env = process.env): Promise<void> {
  return session(account, password, env, async () => undefined);
}

const ASCII = /^[ -~]*$/;
const encodeWord = (text: string): string => (ASCII.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`);

/** A header value with a line break would let a value add headers of its own. */
function oneLine(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new InputError(`The ${what} of an email must be a single line`);
  return value;
}

/** The message as sent: plain-text UTF-8, base64 body in 76-character lines. */
export function buildMessage(message: MailMessage): string {
  const [from, to, subject] = [oneLine(message.from, "sender"), oneLine(message.to, "recipient"), oneLine(message.subject, "subject")];
  const body = Buffer.from(message.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const headers = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encodeWord(subject)}`, `Date: ${new Date(message.date).toUTCString()}`,
    `Message-ID: ${oneLine(message.message_id, "message id")}`,
    ...(message.in_reply_to ? [`In-Reply-To: ${oneLine(message.in_reply_to, "reply id")}`, `References: ${message.in_reply_to}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

export function smtpSend(account: MailAccount, password: string, message: MailMessage, env: Env = process.env): Promise<void> {
  const raw = buildMessage(message);
  return session(account, password, env, async (wire) => {
    await command(wire, `MAIL FROM:<${message.from}>`, [250], "the sender", account.host);
    await command(wire, `RCPT TO:<${message.to}>`, [250, 251], `the recipient ${message.to}`, account.host);
    await command(wire, "DATA", [354], "DATA", account.host);
    await command(wire, `${raw}.`, [250], "the message", account.host);
  });
}
