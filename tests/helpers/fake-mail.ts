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
