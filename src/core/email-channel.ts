import { randomUUID } from "node:crypto";
import type { ChannelConnector, Cursor, EmailConfig } from "./channels.js";
import { joinCodeIn, type RawInbound } from "./envelope.js";
import { MAX_MESSAGE_BYTES, withImap, type ImapSession, type MailboxStatus } from "./imap.js";
import { parseMail } from "./mime.js";
import { smtpSend } from "./smtp.js";

/**
 * The email channel (D75): IMAP polling of INBOX for inbound, SMTP for outbound, one mailbox and one app password
 * (keychain item `email`). The cursor is the mailbox's UIDVALIDITY and the last UID read; a new UIDVALIDITY (the
 * server renumbered the mailbox) restarts from the newest message instead of reading the whole mailbox again.
 */
export const MAILBOX = "INBOX";
/** At most this many messages per poll; the rest follow on the next one. */
export const MAX_FETCH = 20;
type Env = Readonly<Record<string, string | undefined>>;

/** Where reading starts for a mailbox seen for the first time, or renumbered: after its newest message. */
export const startCursor = (status: MailboxStatus): Cursor => ({ uidvalidity: status.uidvalidity, last_uid: Math.max(status.uidnext - 1, 0) });

/**
 * One message, or null when it is gone, has no sender or is the mailbox's own. A message over MAX_MESSAGE_BYTES is
 * never fetched whole: only its headers are read, and its text is a note, so one large email never stops the cursor.
 */
async function readOne(session: ImapSession, config: EmailConfig, uid: number): Promise<RawInbound | null> {
  const size = await session.size(uid);
  if (size === null) return null;
  const tooLarge = size > MAX_MESSAGE_BYTES;
  const mail = parseMail(tooLarge ? await session.headers(uid) : await session.fetch(uid));
  // The mailbox's own mail is dropped (TaskFollow's own sends come back here), except a JOIN line: a person on their own
  // whose only channel is their own mailbox links it that way (D155, D160). The one-time code is the secret, not the sender.
  if (mail.from === "" || (mail.from === config.address.toLowerCase() && joinCodeIn(mail.text) === null)) return null;
  const body = tooLarge ? `(Not read: this email is ${size} bytes, over the limit of ${MAX_MESSAGE_BYTES} bytes; open it in the mailbox)` : mail.text || mail.subject;
  const text = mail.skipped.length > 0 ? `${body}\n(Not kept: ${mail.skipped.join("; ")})` : body;
  const files = mail.attachments.map((attachment) => ({ name: attachment.filename, type: attachment.type, bytes: attachment.bytes }));
  return { channel: "email", from: mail.from, thread: mail.thread_root || `uid:${uid}`, text, message_id: mail.message_id || `uid:${uid}`, files, ...(mail.subject ? { subject: mail.subject } : {}) };
}

async function newMessages(session: ImapSession, config: EmailConfig, last: number): Promise<{ messages: RawInbound[]; last: number }> {
  const uids = (await session.newerThan(last)).slice(0, MAX_FETCH);
  const messages: RawInbound[] = [];
  for (const uid of uids) {
    const message = await readOne(session, config, uid);
    if (message) messages.push(message);
  }
  return { messages, last: uids.at(-1) ?? last };
}

export function emailChannel(config: EmailConfig, password: string, env: Env = process.env): ChannelConnector {
  return {
    id: "email",
    receive: (cursor) => withImap(config.imap, password, async (session) => {
      const status = await session.examine(MAILBOX);
      if (cursor?.uidvalidity !== status.uidvalidity || typeof cursor.last_uid !== "number") return { messages: [], cursor: startCursor(status) };
      const found = await newMessages(session, config, cursor.last_uid);
      return { messages: found.messages, cursor: { uidvalidity: status.uidvalidity, last_uid: found.last } };
    }, env),
    send: async (message) => {
      const domain = config.address.split("@")[1] ?? "localhost";
      const subject = message.subject ?? `Message from ${config.address}`;
      await smtpSend(config.smtp, password, { from: config.address, to: message.to, subject, text: message.text, message_id: `<${randomUUID()}@${domain}>`, date: new Date().toISOString(), ...(message.attachments?.length ? { attachments: message.attachments } : {}), ...(message.in_reply_to ? { in_reply_to: message.in_reply_to } : {}) }, env);
    },
  };
}
