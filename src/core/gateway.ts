import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { confinedPath } from "./actions.js";
import { CHANNEL_FACTS, listChannels, loadCursor, openChannel, saveCursor, type ChannelConnector, type ChannelId } from "./channels.js";
import { writeConfig } from "./data-source.js";
import { handleInbound } from "./inbound.js";
import { announceApprovals } from "./reply-codes.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { toolContext } from "./tools.js";

/**
 * The gateway loop (spec §12.3, D72): one loop per configured channel (Telegram long polling, IMAP polling) and one
 * that announces new approval items. Each round reads a fresh tool context, hands every message to the inbound
 * pipeline, then saves the channel's cursor, so a crash repeats at most one round (the pipeline drops what it has
 * seen). A failing round is logged and retried with a growing pause; nothing is written to stdout. The log holds
 * channel names, counts and error messages, never message text or secrets.
 */
export const GATEWAY_DIR = join("runtime", "gateway");
export const LOG_FILE = join(GATEWAY_DIR, "gateway.log");
/** One heartbeat file per loop (`telegram`, `email`, `approvals`), so two loops never write the same file. */
export const statusFile = (loopName: string): string => join(GATEWAY_DIR, `${loopName}.status.json`);
const MAX_BACKOFF_MS = 60_000;

export interface GatewayOptions {
  readonly home: string;
  readonly signal: AbortSignal;
  /** Telegram long-poll wait (Telegram allows up to 50 s). */
  readonly pollSeconds: number;
  /** Pause between two IMAP polls, and between two approval announcements. */
  readonly pauseMs: number;
  readonly now?: () => string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

type Clock = () => string;
const clock = (options: GatewayOptions): Clock => options.now ?? (() => new Date().toISOString());

export async function gatewayLog(home: string, now: string, entry: Record<string, unknown>): Promise<void> {
  const path = await confinedPath(home, LOG_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify({ ts: now, ...entry })}\n`, { encoding: "utf8", mode: 0o600 });
}

/** One round on one channel: receive, handle each message, then move the cursor past them. */
export async function receiveRound(options: GatewayOptions, id: ChannelId, opened?: ChannelConnector): Promise<number> {
  const { home, signal, env } = options;
  const channel = opened ?? (await openChannel(home, id, env));
  const { messages, cursor } = await channel.receive(await loadCursor(home, id), waitsLong(id) ? options.pollSeconds : 0, signal);
  const ctx = await toolContext(home, "gateway", DEFAULT_TOOLS, clock(options));
  for (const message of messages) await handleInbound(ctx, message);
  if (cursor) await saveCursor(home, id, cursor);
  return messages.length;
}

/** Telegram polls for a long time; Slack waits on its live connection. Email asks and moves on. */
const waitsLong = (id: ChannelId): boolean => CHANNEL_FACTS[id].capabilities.inbound === "long_poll" || CHANNEL_FACTS[id].capabilities.inbound === "socket";

/** Repeats `round` until the gateway stops; a failure is logged and waits 1 s, 2 s, 4 s … up to a minute. */
async function loop(options: GatewayOptions, name: string, round: () => Promise<number>, pauseMs: number): Promise<void> {
  let failures = 0;
  while (!options.signal.aborted) {
    try {
      const handled = await round();
      if (failures > 0 || handled > 0) await gatewayLog(options.home, clock(options)(), { level: "info", loop: name, handled });
      failures = 0;
      await writeConfig(options.home, statusFile(name), { pid: process.pid, last_round: clock(options)() });
    } catch (error) {
      failures += 1;
      await gatewayLog(options.home, clock(options)(), { level: "error", loop: name, error: (error as Error).message, failures });
    }
    const wait = failures > 0 ? Math.min(1000 * 2 ** (failures - 1), MAX_BACKOFF_MS) : pauseMs;
    await sleep(wait, undefined, { signal: options.signal }).catch(() => undefined);
  }
}

/** Runs until `signal` aborts; the channels are the ones configured when it starts. */
export async function runGateway(options: GatewayOptions): Promise<void> {
  const channels = (await listChannels(options.home)).map((config) => config.channel);
  await gatewayLog(options.home, clock(options)(), { level: "info", event: "started", pid: process.pid, channels });
  const announce = async () => (await announceApprovals(await toolContext(options.home, "gateway", DEFAULT_TOOLS, clock(options)))).length;
  // A channel with a live connection is opened once per run, so the connection lasts; the others are opened each round.
  const live = new Map<ChannelId, ChannelConnector>();
  const roundOf = async (id: ChannelId): Promise<number> => {
    if (CHANNEL_FACTS[id].capabilities.inbound !== "socket") return receiveRound(options, id);
    let connector = live.get(id);
    if (!connector) {
      connector = await openChannel(options.home, id, options.env);
      live.set(id, connector);
    }
    return receiveRound(options, id, connector);
  };
  await Promise.all([
    ...channels.map((id) => loop(options, id, () => roundOf(id), waitsLong(id) ? 0 : options.pauseMs)),
    loop(options, "approvals", announce, options.pauseMs),
  ]);
  await Promise.all([...live.values()].map((connector) => connector.close?.()));
  await gatewayLog(options.home, clock(options)(), { level: "info", event: "stopped", pid: process.pid });
}
