import { readFileSync } from "node:fs";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";

/**
 * A line connection for the mail protocols (IMAP, SMTP), on `node:net` and `node:tls` only. `ssl` is TLS from the
 * first byte (ports 993 / 465); `starttls` starts in plain text and is upgraded with `startTls()` before any
 * credential is sent. Certificates are checked against the system's trusted roots; tests trust their own
 * certificate through INSTALLER_TLS_CA, accepted for a server on 127.0.0.1 only.
 */
export const MAIL_SECURITY = ["ssl", "starttls"] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];
export const TLS_CA_ENV = "INSTALLER_TLS_CA";
export const WIRE_TIMEOUT_MS = 30_000;
const MAX_LINE_BYTES = 1_000_000;
type Env = Readonly<Record<string, string | undefined>>;

export interface Endpoint {
  readonly host: string;
  readonly port: number;
  readonly security: MailSecurity;
}

export interface Wire {
  /** The next line, without its CRLF. */
  readonly readLine: () => Promise<string>;
  /** Exactly `count` bytes (an IMAP literal). */
  readonly readBytes: (count: number) => Promise<Buffer>;
  readonly write: (text: string) => Promise<void>;
  /** STARTTLS: upgrade the plain connection in place. */
  readonly startTls: () => Promise<void>;
  readonly close: () => void;
}

export function tlsOptions(host: string, env: Env = process.env): ConnectionOptions {
  const ca = env[TLS_CA_ENV];
  if (!ca) return { host, ...(isIP(host) ? {} : { servername: host }) };
  if (host !== "127.0.0.1") throw new InputError(`${TLS_CA_ENV} is only for a test server on 127.0.0.1, not ${host}`);
  return { host, ca: readFileSync(ca) };
}

function failure(endpoint: Endpoint, error: NodeJS.ErrnoException): ActionFailure {
  const code = error.code ?? error.message;
  if (/CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY/.test(code)) return new ActionFailure(`The TLS certificate of ${endpoint.host} is not trusted (${code})`);
  return new ActionFailure(`Cannot reach the mail server ${endpoint.host}:${endpoint.port} (${code})`);
}

function waitFor(socket: Socket, event: "connect" | "secureConnect", endpoint: Endpoint): Promise<void> {
  return new Promise((done, fail) => {
    socket.once(event, () => done());
    socket.once("error", (error: NodeJS.ErrnoException) => fail(failure(endpoint, error)));
  });
}

/** Buffers what arrives and hands it out as lines or byte counts; a closed or failed connection fails the reader. */
function lineBuffer(endpoint: Endpoint) {
  let buffer = Buffer.alloc(0);
  let broken: Error | null = null;
  let wake: () => void = () => undefined;
  /** `lineLimit`: a line may not grow past it; a byte count the caller asked for is bounded by that count instead. */
  const until = async (ready: () => boolean, lineLimit = Infinity): Promise<void> => {
    while (!ready()) {
      if (broken) throw broken;
      if (buffer.length > lineLimit) throw new ActionFailure(`The mail server ${endpoint.host} sent an answer that is too long`);
      await new Promise<void>((tick) => {
        wake = tick;
      });
    }
  };
  const take = (count: number, skip: number): Buffer => {
    const head = Buffer.from(buffer.subarray(0, count));
    buffer = buffer.subarray(count + skip);
    return head;
  };
  return {
    pending: (): number => buffer.length,
    onData: (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      wake();
    },
    onEnd: (error?: NodeJS.ErrnoException): void => {
      broken = error ? failure(endpoint, error) : new ActionFailure(`The mail server ${endpoint.host} closed the connection`);
      wake();
    },
    readLine: async (): Promise<string> => {
      await until(() => buffer.includes("\r\n"), MAX_LINE_BYTES);
      return take(buffer.indexOf("\r\n"), 2).toString("utf8");
    },
    readBytes: async (count: number): Promise<Buffer> => {
      await until(() => buffer.length >= count);
      return take(count, 0);
    },
  };
}

export async function openWire(endpoint: Endpoint, env: Env = process.env): Promise<Wire> {
  const options = tlsOptions(endpoint.host, env);
  let socket: Socket = endpoint.security === "ssl" ? tlsConnect({ ...options, port: endpoint.port }) : netConnect({ host: endpoint.host, port: endpoint.port });
  await waitFor(socket, endpoint.security === "ssl" ? "secureConnect" : "connect", endpoint);
  let reader = lineBuffer(endpoint);
  const attach = (target: Socket): void => {
    target.setTimeout(WIRE_TIMEOUT_MS, () => target.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    target.on("data", reader.onData).on("error", reader.onEnd).on("close", () => reader.onEnd());
  };
  attach(socket);
  return {
    readLine: () => reader.readLine(),
    readBytes: (count) => reader.readBytes(count),
    write: (text) => new Promise((done, fail) => socket.write(text, (error) => (error ? fail(failure(endpoint, error)) : done()))),
    /** RFC 3207 §4.2: nothing read in plain text may count after the upgrade, so unread bytes end the connection. */
    startTls: async () => {
      if (reader.pending() > 0) throw new ActionFailure(`The mail server ${endpoint.host} sent data before the TLS handshake; nothing was sent`);
      socket.removeAllListeners("data").removeAllListeners("error").removeAllListeners("close").setTimeout(0);
      socket = tlsConnect({ ...options, socket });
      await waitFor(socket, "secureConnect", endpoint);
      reader = lineBuffer(endpoint);
      attach(socket);
    },
    close: () => {
      socket.removeAllListeners("close");
      socket.destroy();
    },
  };
}
