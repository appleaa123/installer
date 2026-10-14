import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionFailure } from "./failure.js";
import type { SlackApi } from "./slack.js";

/**
 * Slack's Socket Mode (D135): the gateway opens one live connection with the client's own app token and Slack pushes
 * events over it, so no public address is needed. The order is what keeps a message from being lost: an event is
 * written to a spool file first and acknowledged only after that, so a crash after the write loses nothing and a
 * crash before it makes Slack send the event again. When too much is waiting the event is not acknowledged either, so
 * Slack keeps it. `receive` hands the spooled events to the gateway and deletes what an earlier round finished.
 * Slack refreshes a connection every few hours and warns before it does: the new connection is opened before the old
 * one is closed. Uses Node's built-in WebSocket; no dependency.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 60_000 };
const DEFAULT_MAX_SPOOL = 500;
/** A connection is renewed at least this often, since a silently dead one cannot be told apart without pings. */
const MAX_CONNECTION_MS = 3_600_000;
const MAX_REMEMBERED = 1000;

export interface SpooledEvent {
  readonly seq: number;
  /** The `payload` of Slack's events_api envelope. */
  readonly payload: unknown;
}

export interface SlackSocketOptions {
  readonly api: SlackApi;
  readonly spoolDir: string;
  readonly env?: Env;
  readonly backoff?: { readonly initialMs: number; readonly maxMs: number };
  readonly maxSpool?: number;
  readonly log?: (message: string) => void;
}

/** Only Slack's own addresses; a loopback address only for tests with the throwaway keychain (same rule as connectorUrl). */
export function socketUrlAllowed(url: string, env: Env): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "wss:") return parsed.hostname.endsWith(".slack.com");
  if (parsed.protocol !== "ws:") return false;
  const server = env.INSTALLER_CONNECTOR_SERVER;
  if (!server || env.INSTALLER_KEYCHAIN !== "file") return false;
  return parsed.hostname === "127.0.0.1" && new URL(server).port === parsed.port;
}

const spoolName = (seq: number): string => `${String(seq).padStart(10, "0")}.json`;
const seqOf = (name: string): number => Number.parseInt(name, 10);

export class SlackSocket {
  private readonly sockets = new Set<WebSocket>();
  private readonly remembered: string[] = [];
  private waiters: (() => void)[] = [];
  /** Events are handled one at a time, so the count of waiting events is always true when the next one is judged. */
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private started = false;
  private nextSeq = -1;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: SlackSocketOptions) {
    this.backoffMs = (options.backoff ?? DEFAULT_BACKOFF).initialMs;
  }

  private get env(): Env {
    return this.options.env ?? process.env;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** The events after `afterSeq`, waiting up to `waitSeconds` for one; what up to `afterSeq` is deleted first. */
  async receive(afterSeq: number, waitSeconds: number, signal: AbortSignal): Promise<SpooledEvent[]> {
    await this.prepare();
    this.start();
    await this.prune(afterSeq);
    let events = await this.read(afterSeq);
    if (events.length === 0 && waitSeconds > 0 && !signal.aborted) {
      await this.wait(waitSeconds * 1000, signal);
      events = await this.read(afterSeq);
    }
    return events;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
    this.wake();
  }

  private async prepare(): Promise<void> {
    if (this.nextSeq >= 0) return;
    await mkdir(this.options.spoolDir, { recursive: true, mode: 0o700 });
    const names = await readdir(this.options.spoolDir);
    this.nextSeq = Math.max(0, ...names.map(seqOf).filter(Number.isFinite));
  }

  private start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let url: string;
    try {
      url = await this.options.api.connectionsOpen();
    } catch (error) {
      this.log(`Slack connection not opened: ${(error as Error).message}`);
      return this.scheduleReconnect();
    }
    if (!socketUrlAllowed(url, this.env)) {
      this.log("Slack gave a connection address that is not Slack's: ignored");
      return this.scheduleReconnect();
    }
    const socket = new WebSocket(url);
    this.sockets.add(socket);
    socket.addEventListener("message", (event) => void this.onMessage(socket, String(event.data)));
    socket.addEventListener("error", () => undefined);
    socket.addEventListener("close", () => {
      this.sockets.delete(socket);
      if (!this.closed && this.sockets.size === 0) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const { maxMs } = this.options.backoff ?? DEFAULT_BACKOFF;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, this.backoffMs);
    this.reconnectTimer.unref();
    this.backoffMs = Math.min(this.backoffMs * 2, maxMs);
  }

  private async onMessage(socket: WebSocket, data: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === "hello") return this.onHello(socket);
    if (message.type === "disconnect") return this.onDisconnect(message.reason);
    if (typeof message.envelope_id !== "string") return;
    if (message.type !== "events_api") return this.acknowledge(socket, message.envelope_id);
    const envelopeId = message.envelope_id;
    this.queue = this.queue.then(() => this.onEvent(socket, envelopeId, message.payload)).catch((error: unknown) => this.log(`Slack event not stored: ${(error as Error).message}`));
    await this.queue;
  }

  /** A new connection is ready: renew it later, and close the older ones now that this one carries the events. */
  private onHello(socket: WebSocket): void {
    this.backoffMs = (this.options.backoff ?? DEFAULT_BACKOFF).initialMs;
    for (const older of this.sockets) {
      if (older !== socket) older.close();
    }
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.connect(), MAX_CONNECTION_MS);
    this.refreshTimer.unref();
  }

  private onDisconnect(reason: unknown): void {
    if (reason === "link_disabled") {
      this.log("Slack turned Socket Mode off for this app: check the app settings");
      return this.scheduleReconnect();
    }
    void this.connect();
  }

  private async onEvent(socket: WebSocket, envelopeId: string, payload: unknown): Promise<void> {
    if (this.remembered.includes(envelopeId)) return this.acknowledge(socket, envelopeId);
    if ((await readdir(this.options.spoolDir)).length >= (this.options.maxSpool ?? DEFAULT_MAX_SPOOL)) return;
    const seq = ++this.nextSeq;
    await writeFile(join(this.options.spoolDir, spoolName(seq)), JSON.stringify({ payload }), { mode: 0o600 });
    this.remembered.push(envelopeId);
    if (this.remembered.length > MAX_REMEMBERED) this.remembered.shift();
    this.acknowledge(socket, envelopeId);
    this.wake();
  }

  private acknowledge(socket: WebSocket, envelopeId: string): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelopeId }));
  }

  private async read(afterSeq: number): Promise<SpooledEvent[]> {
    const names = (await readdir(this.options.spoolDir)).filter((name) => seqOf(name) > afterSeq).sort();
    const events: SpooledEvent[] = [];
    for (const name of names) {
      const parsed: unknown = JSON.parse(await readFile(join(this.options.spoolDir, name), "utf8"));
      if (isRecord(parsed)) events.push({ seq: seqOf(name), payload: parsed.payload });
    }
    return events;
  }

  private async prune(afterSeq: number): Promise<void> {
    for (const name of await readdir(this.options.spoolDir)) {
      if (seqOf(name) <= afterSeq) await rm(join(this.options.spoolDir, name), { force: true });
    }
  }

  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.waiters = this.waiters.filter((waiter) => waiter !== finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish);
      this.waiters.push(finish);
    });
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

/**
 * Opens a connection just long enough to read Slack's hello: it proves the app token works and Socket Mode is on, and
 * says which app this is. Used by the setup page, which keeps that app id to recognise this app's events later.
 */
export function waitForHello(url: string, env: Env, timeoutMs = 10_000): Promise<{ readonly app_id: string }> {
  return new Promise((done, fail) => {
    if (!socketUrlAllowed(url, env)) return fail(new ActionFailure("Slack gave a connection address that is not Slack's: nothing was connected"));
    const silent = new ActionFailure("Slack did not answer on the live connection: check that Socket Mode is turned on for the app, then try again");
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      fail(silent);
    }, timeoutMs);
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      fail(silent);
    });
    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isRecord(message) || message.type !== "hello") return;
      clearTimeout(timer);
      socket.close();
      const info = isRecord(message.connection_info) ? message.connection_info : {};
      if (typeof info.app_id === "string") done({ app_id: info.app_id });
      else fail(new ActionFailure("Slack's hello did not say which app this is"));
    });
  });
}
