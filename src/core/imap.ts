import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import type { MailAccount } from "./smtp.js";
import { openWire, type Wire } from "./wire.js";

/**
 * Inbound mail over IMAP4rev1 (RFC 3501), read-only: LOGIN with quoted strings, EXAMINE (never SELECT), UID SEARCH
 * and UID FETCH with BODY.PEEK[], so the mailbox is never changed, not even its \Seen flags. The gateway keeps
 * its own cursor (UIDVALIDITY + last UID) instead. A literal over MAX_MESSAGE_BYTES is refused; the email channel
 * asks for RFC822.SIZE first and reads only the headers of a larger message.
 */
export interface MailboxStatus {
  readonly uidvalidity: number;
  readonly uidnext: number;
}

export interface ImapSession {
  readonly examine: (mailbox: string) => Promise<MailboxStatus>;
  /** UIDs above `uid`, oldest first (`n:*` always names the last message, so it is filtered here). */
  readonly newerThan: (uid: number) => Promise<number[]>;
  /** The whole message, as bytes. */
  readonly fetch: (uid: number) => Promise<Buffer>;
  /** The message's size in bytes (RFC822.SIZE), or null when it is gone (expunged since the search). */
  readonly size: (uid: number) => Promise<number | null>;
  /** Only the sender, subject and id headers, for a message too large to fetch. */
  readonly headers: (uid: number) => Promise<Buffer>;
}

interface Response {
  readonly status: string;
  readonly text: string;
  readonly untagged: readonly { readonly line: string; readonly literal?: Buffer }[];
}

type Env = Readonly<Record<string, string | undefined>>;
const LITERAL = /\{(\d+)\}$/;
/** A message larger than this is never fetched whole; the email channel reads only its headers. */
export const MAX_MESSAGE_BYTES = 10_000_000;
const HEADER_FIELDS = "HEADER.FIELDS (FROM SUBJECT MESSAGE-ID IN-REPLY-TO)";

/** An IMAP quoted string: `\` and `"` escaped; line breaks and non-ASCII cannot be quoted. */
export function quoted(value: string, what: string): string {
  if (!/^[ -~]*$/.test(value)) throw new InputError(`The ${what} must be printable ASCII to sign in with IMAP`);
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function protocol(wire: Wire, host: string) {
  let counter = 0;
  /** One untagged line, with its literal when the line announces one (`{n}`); the rest of the line follows it. */
  const readItem = async (): Promise<{ line: string; literal?: Buffer }> => {
    const line = await wire.readLine();
    const size = LITERAL.exec(line)?.[1];
    if (size === undefined) return { line };
    if (Number(size) > MAX_MESSAGE_BYTES) throw new ActionFailure(`The mail server ${host} sent a message larger than ${MAX_MESSAGE_BYTES} bytes`);
    const literal = await wire.readBytes(Number(size));
    return { line: `${line}${await wire.readLine()}`, literal };
  };
  return async (command: string, what: string): Promise<Response> => {
    const tag = `i${++counter}`;
    await wire.write(`${tag} ${command}\r\n`);
    const untagged: Response["untagged"][number][] = [];
    for (;;) {
      const item = await readItem();
      if (!item.line.startsWith(`${tag} `)) {
        untagged.push(item);
        continue;
      }
      const [status = "", ...rest] = item.line.slice(tag.length + 1).split(" ");
      const response = { status: status.toUpperCase(), text: rest.join(" "), untagged };
      if (response.status !== "OK") throw new ActionFailure(`The mail server ${host} refused ${what} (${response.status} ${response.text.slice(0, 200)})`);
      return response;
    }
  };
}

function statusOf(response: Response): MailboxStatus {
  const number = (name: string): number => Number(response.untagged.map((item) => new RegExp(`\\[${name} (\\d+)\\]`).exec(item.line)?.[1]).find(Boolean) ?? 0);
  return { uidvalidity: number("UIDVALIDITY"), uidnext: number("UIDNEXT") };
}

async function literalOf(run: ReturnType<typeof protocol>, uid: number, item: string, host: string): Promise<Buffer> {
  const found = await run(`UID FETCH ${uid} (${item})`, `message ${uid}`);
  const literal = found.untagged.find((entry) => entry.literal !== undefined)?.literal;
  if (!literal) throw new ActionFailure(`The mail server ${host} returned no message ${uid}`);
  return literal;
}

async function signIn(wire: Wire, run: ReturnType<typeof protocol>, account: MailAccount, password: string): Promise<void> {
  const greeting = await wire.readLine();
  if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) throw new ActionFailure(`The mail server ${account.host} did not greet as IMAP (${greeting.slice(0, 100)})`);
  if (account.security === "starttls") {
    await run("STARTTLS", "STARTTLS");
    await wire.startTls();
  }
  const login = `LOGIN ${quoted(account.user, "user")} ${quoted(password, "app password")}`;
  await run(login, `the sign-in for ${account.user}`).catch((error: unknown) => {
    if (!(error instanceof ActionFailure)) throw error;
    throw new ActionFailure(`${error.message}: check the user and the app password, then run 'taskfollow secret email' again`);
  });
}

/** Signs in, runs `task` on a read-only session, logs out; the connection is always closed. */
export async function withImap<T>(account: MailAccount, password: string, task: (session: ImapSession) => Promise<T>, env: Env = process.env): Promise<T> {
  const wire = await openWire(account, env);
  const run = protocol(wire, account.host);
  try {
    await signIn(wire, run, account, password);
    const result = await task({
      examine: async (mailbox) => statusOf(await run(`EXAMINE ${quoted(mailbox, "mailbox name")}`, `to open ${mailbox}`)),
      newerThan: async (uid) => {
        const found = await run(`UID SEARCH UID ${uid + 1}:*`, "the search");
        const uids = found.untagged.flatMap((item) => (/^\* SEARCH\b/i.test(item.line) ? item.line.split(" ").slice(2).map(Number) : []));
        return uids.filter((value) => value > uid).sort((a, b) => a - b);
      },
      fetch: (uid) => literalOf(run, uid, "BODY.PEEK[]", account.host),
      size: async (uid) => {
        const found = await run(`UID FETCH ${uid} (RFC822.SIZE)`, `the size of message ${uid}`);
        const size = found.untagged.map((item) => /\bRFC822\.SIZE (\d+)/i.exec(item.line)?.[1]).find(Boolean);
        return size === undefined ? null : Number(size);
      },
      headers: (uid) => literalOf(run, uid, `BODY.PEEK[${HEADER_FIELDS}]`, account.host),
    });
    await run("LOGOUT", "LOGOUT");
    return result;
  } finally {
    wire.close();
  }
}
