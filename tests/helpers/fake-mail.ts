import { readFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { TLSSocket, createServer as createTlsServer } from "node:tls";

/**
 * In-process fake mail servers on 127.0.0.1 for the offline tests, with the test certificate in
 * tests/fixtures/tls (a self-signed certificate for 127.0.0.1). The client trusts it through TEST_TLS_ENV.
 */
const KEY = readFileSync("tests/fixtures/tls/key.pem");
const CERT = readFileSync("tests/fixtures/tls/cert.pem");
export const TEST_TLS_ENV = { INSTALLER_TLS_CA: resolve("tests/fixtures/tls/cert.pem") };
export const MAIL_USER = "desk@example.com";
export const MAIL_PASSWORD = "app-pass \"quoted\" \\ 1";

export interface LineSession {
  readonly send: (line: string) => void;
  /** STARTTLS on the server side: the next bytes are a TLS handshake. */
  readonly upgrade: () => void;
  readonly secure: () => boolean;
  readonly close: () => void;
}

export interface FakeServer {
  readonly port: number;
  readonly stop: () => Promise<void>;
}

type Security = "ssl" | "starttls";

/** Calls `onLine` for every CRLF line, before and after a STARTTLS upgrade. */
function lineSession(first: Socket, startSecure: boolean, onLine: (line: string, session: LineSession) => void): LineSession {
  let socket = first;
  let secure = startSecure;
  let buffer = "";
  const listen = (target: Socket): void => {
    target.setEncoding("utf8");
    target.on("data", (chunk: string) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line, session);
      }
    });
    target.on("error", () => undefined);
  };
  const session: LineSession = {
    send: (line) => void socket.write(`${line}\r\n`),
    upgrade: () => {
      socket.removeAllListeners("data");
      socket = new TLSSocket(socket, { isServer: true, key: KEY, cert: CERT });
      secure = true;
      listen(socket);
    },
    secure: () => secure,
    close: () => void socket.end(),
  };
  listen(socket);
  return session;
}

/** A server whose connections speak lines; `greet` runs once per connection. */
export function lineServer(security: Security, greet: (session: LineSession) => (line: string) => void): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const accept = (socket: Socket): void => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let handler: (line: string) => void = () => undefined;
    const session = lineSession(socket, security === "ssl", (line) => handler(line));
    handler = greet(session);
  };
  const server: Server = security === "ssl" ? createTlsServer({ key: KEY, cert: CERT }, accept) : createNetServer(accept);
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({
        port: (server.address() as AddressInfo).port,
        stop: () => new Promise((closed) => {
          sockets.forEach((socket) => socket.destroy());
          server.close(() => closed());
        }),
      });
    });
  });
}

export interface ReceivedMail {
  readonly from: string;
  readonly to: string;
  readonly data: string;
}

export interface FakeSmtp extends FakeServer {
  readonly received: ReceivedMail[];
  /** Every AUTH PLAIN seen: who, and whether the connection was already encrypted. */
  readonly logins: { user: string; password: string; secure: boolean }[];
}

/** SMTP: EHLO, STARTTLS (when `starttls`), AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
export async function startFakeSmtp(security: Security, options: { offerStartTls?: boolean } = {}): Promise<FakeSmtp> {
  const received: ReceivedMail[] = [];
  const logins: FakeSmtp["logins"] = [];
  const server = await lineServer(security, (session) => {
    const mail = { from: "", to: "", data: [] as string[], inData: false, authed: false };
    session.send("220 fake.test ESMTP ready");
    return (line) => {
      if (mail.inData) {
        if (line !== ".") return void mail.data.push(line);
        mail.inData = false;
        received.push({ from: mail.from, to: mail.to, data: mail.data.join("\r\n") });
        return session.send("250 2.0.0 queued");
      }
      const [verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO": {
          const tls = security === "starttls" && !session.secure() && options.offerStartTls !== false ? ["250-STARTTLS"] : [];
          return ["250-fake.test", ...tls, "250 AUTH PLAIN LOGIN"].forEach((reply) => session.send(reply));
        }
        case "STARTTLS":
          session.send("220 2.0.0 go ahead");
          return session.upgrade();
        case "AUTH": {
          const [, user = "", password = ""] = Buffer.from(arg.replace(/^PLAIN /i, ""), "base64").toString("utf8").split("\u0000");
          logins.push({ user, password, secure: session.secure() });
          mail.authed = user === MAIL_USER && password === MAIL_PASSWORD;
          return session.send(mail.authed ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication failed");
        }
        case "MAIL":
          mail.from = arg.replace(/^FROM:<(.*)>$/i, "$1");
          return session.send(mail.authed ? "250 2.1.0 ok" : "530 5.7.0 Authentication required");
        case "RCPT":
          mail.to = arg.replace(/^TO:<(.*)>$/i, "$1");
          return session.send("250 2.1.5 ok");
        case "DATA":
          mail.inData = true;
          return session.send("354 End data with <CR><LF>.<CR><LF>");
        case "QUIT":
          session.send("221 2.0.0 bye");
          return session.close();
        default:
          return session.send("502 5.5.2 not implemented");
      }
    };
  });
  return { ...server, received, logins };
}

export interface FakeImap extends FakeServer {
  /** Every command after the tag, LOGIN's password masked; a test checks that nothing writes to the mailbox. */
  readonly commands: string[];
  readonly logins: { user: string; password: string; secure: boolean }[];
  /** Adds a message to INBOX; UIDs start at 101. */
  readonly deliver: (raw: string) => void;
  /** The message is expunged between a SEARCH and a FETCH: still listed, never returned. */
  readonly vanish: (uid: number) => void;
}

const QUOTED = /"((?:[^"\\]|\\.)*)"/g;
const unquote = (text: string): string[] => [...text.matchAll(QUOTED)].map((match) => (match[1] ?? "").replace(/\\(.)/g, "$1"));

/** IMAP4rev1, read-only: STARTTLS, LOGIN, EXAMINE, UID SEARCH, UID FETCH (BODY.PEEK[]), LOGOUT. UIDVALIDITY 7. */
export async function startFakeImap(security: Security, messages: readonly string[] = []): Promise<FakeImap> {
  const inbox = [...messages];
  const gone = new Set<number>();
  const commands: string[] = [];
  const logins: FakeImap["logins"] = [];
  const uidOf = (index: number): number => 101 + index;
  const server = await lineServer(security, (session) => {
    session.send("* OK [CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN] fake.test ready");
    let authed = false;
    return (line) => {
      const [tag = "", verb = "", ...rest] = line.split(" ");
      const arg = rest.join(" ");
      const done = (text = "completed"): void => session.send(`${tag} OK ${text}`);
      commands.push(verb.toUpperCase() === "LOGIN" ? "LOGIN ***" : `${verb} ${arg}`.trim());
      switch (verb.toUpperCase()) {
        case "STARTTLS":
          done("begin TLS");
          return session.upgrade();
        case "LOGIN": {
          const [user = "", password = ""] = unquote(arg);
          logins.push({ user, password, secure: session.secure() });
          authed = user === MAIL_USER && password === MAIL_PASSWORD;
          return authed ? done("LOGIN completed") : session.send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
        case "EXAMINE":
          if (!authed) return session.send(`${tag} BAD not signed in`);
          [`* ${inbox.length} EXISTS`, "* OK [UIDVALIDITY 7] UIDs valid", `* OK [UIDNEXT ${uidOf(inbox.length)}] next`].forEach((reply) => session.send(reply));
          return done("[READ-ONLY] EXAMINE completed");
        case "UID":
          return uidCommand(session, tag, arg, inbox.map((raw, index) => (gone.has(uidOf(index)) ? undefined : raw)), uidOf);
        case "LOGOUT":
          session.send("* BYE logging out");
          done();
          return session.close();
        default:
          return session.send(`${tag} BAD unknown command`);
      }
    };
  });
  return { ...server, commands, logins, deliver: (raw) => void inbox.push(raw), vanish: (uid) => void gone.add(uid) };
}

/** `UID SEARCH UID n:*` (like real servers, it always names the last message) and `UID FETCH n (BODY.PEEK[])`. */
function uidCommand(session: LineSession, tag: string, arg: string, inbox: readonly (string | undefined)[], uidOf: (index: number) => number): void {
  const search = /^SEARCH UID (\d+):\*$/i.exec(arg);
  if (search) {
    const from = Number(search[1]);
    const uids = inbox.map((_raw, index) => uidOf(index)).filter((uid, index) => uid >= from || index === inbox.length - 1);
    session.send(`* SEARCH${uids.map((uid) => ` ${uid}`).join("")}`);
    return session.send(`${tag} OK SEARCH completed`);
  }
  const fetch = /^FETCH (\d+) \((BODY\.PEEK\[\]|RFC822\.SIZE|BODY\.PEEK\[HEADER\.FIELDS \(([^)]*)\)\])\)$/i.exec(arg);
  const index = fetch ? Number(fetch[1]) - 101 : -1;
  const raw = inbox[index];
  if (raw === undefined || !fetch) return session.send(`${tag} OK FETCH completed`);
  const item = fetch[2]?.toUpperCase() ?? "";
  if (item === "RFC822.SIZE") session.send(`* ${index + 1} FETCH (UID ${uidOf(index)} RFC822.SIZE ${Buffer.byteLength(raw)})`);
  else if (item === "BODY.PEEK[]") session.send(`* ${index + 1} FETCH (UID ${uidOf(index)} BODY[] {${Buffer.byteLength(raw)}}\r\n${raw})`);
  else {
    const part = headerFields(raw, (fetch[3] ?? "").split(" "));
    session.send(`* ${index + 1} FETCH (UID ${uidOf(index)} BODY[HEADER.FIELDS (${fetch[3]})] {${Buffer.byteLength(part)}}\r\n${part})`);
  }
  return session.send(`${tag} OK FETCH completed`);
}

/** The named header fields of a message, as `BODY[HEADER.FIELDS (…)]` returns them (ending with a blank line). */
function headerFields(raw: string, names: readonly string[]): string {
  const wanted = names.map((name) => name.toLowerCase());
  const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
  return `${head.split("\r\n").filter((line) => wanted.includes(line.slice(0, line.indexOf(":")).toLowerCase())).join("\r\n")}\r\n\r\n`;
}
