import { randomUUID } from "node:crypto";
import type { ChannelConnector, Cursor, EmailConfig } from "./channels.js";
import type { RawInbound } from "./envelope.js";
import { withImap, type ImapSession, type MailboxStatus } from "./imap.js";
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

async function newMessages(session: ImapSession, config: EmailConfig, last: number): Promise<{ messages: RawInbound[]; last: number }> {
  const uids = (await session.newerThan(last)).slice(0, MAX_FETCH);
  const messages: RawInbound[] = [];
  for (const uid of uids) {
    const mail = parseMail(await session.fetch(uid));
    if (mail.from === "" || mail.from === config.address.toLowerCase()) continue;
    const text = mail.text || mail.subject;
    messages.push({ channel: "email", from: mail.from, thread: mail.in_reply_to || mail.message_id || `uid:${uid}`, text, message_id: mail.message_id || `uid:${uid}` });
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
      await smtpSend(config.smtp, password, { from: config.address, to: message.to, subject, text: message.text, message_id: `<${randomUUID()}@${domain}>`, date: new Date().toISOString() }, env);
    },
  };
}
