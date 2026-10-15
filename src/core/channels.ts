import { rm } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { readConfig, writeConfig } from "./data-source.js";
import { emailChannel } from "./email-channel.js";
import { slackChannel } from "./slack-channel.js";
import { whatsappChannel } from "./whatsapp-channel.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import type { MailAccount } from "./smtp.js";
import { StateCorruptError } from "./state.js";
import { telegramApi, telegramInbound, type TelegramBot } from "./telegram.js";

/**
 * Channel connectors (spec §12.2, D73): one interface, receive + send + declared capabilities. v1 has two built-in
 * adapters, Telegram and email, configured by `taskfollow channel <id>` into `config/channels/<id>.json` (no secrets:
 * the bot token and the app password stay in the keychain items `telegram` and `email`). The gateway keeps each
 * channel's read position in `state/gateway/<id>.cursor.json`.
 */
export const CHANNEL_IDS = ["telegram", "email", "slack", "whatsapp"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
export const CHANNELS_DIR = join("config", "channels");
export const CURSORS_DIR = join("state", "gateway");

export interface ChannelCapabilities {
  readonly buttons: boolean;
  readonly attachments: readonly string[];
  readonly reply_window: "none" | "24h";
  readonly inbound: "long_poll" | "webhook" | "imap_poll" | "socket" | "relay_poll";
}

export interface ChannelRisk {
  readonly official_api: boolean;
  readonly outbound_external: boolean;
  /** The platform proves who sent a message (a Telegram user id). An email's From line can be forged, so it cannot (D78). */
  readonly sender_verified: boolean;
  /** WhatsApp v1 (D149): for customers only; members never join, decide or pause over it. */
  readonly customers_only?: boolean;
}

/** v1 uses reply codes (buttons later) and stores no attachments. */
export const CHANNEL_FACTS: Readonly<Record<ChannelId, { readonly capabilities: ChannelCapabilities; readonly risk: ChannelRisk }>> = {
  telegram: { capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "long_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: true } },
  email: { capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "imap_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: false } },
  slack: { capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "socket" }, risk: { official_api: true, outbound_external: false, sender_verified: true } },
  whatsapp: { capabilities: { buttons: false, attachments: [], reply_window: "24h", inbound: "relay_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: true, customers_only: true } },
};

/** A channel only customers write on (WhatsApp, D149): no joining, reply codes or kill switch there. */
export const isCustomersOnly = (id: string): boolean => (CHANNEL_IDS as readonly string[]).includes(id) && CHANNEL_FACTS[id as ChannelId].risk.customers_only === true;

/** A channel that reaches the client's own team only (Slack): no outside contacts, so no `channel.send` (D135). */
export const isInternalOnly = (id: ChannelId): boolean => !CHANNEL_FACTS[id].risk.outbound_external;

/** Slack keeps `/` for its own slash commands, so `JOIN` and `pause` work there without it (D135). */
export const bareCommands = (id: string): boolean => id === "slack";

export interface TelegramConfig {
  readonly channel: "telegram";
  readonly bot: TelegramBot;
  readonly verified_at: string;
}

export interface EmailConfig {
  readonly channel: "email";
  readonly address: string;
  readonly imap: MailAccount;
  readonly smtp: MailAccount;
  readonly verified_at: string;
}

export interface SlackConfig {
  readonly channel: "slack";
  readonly team_id: string;
  readonly team: string;
  readonly bot_user_id: string;
  /** Slack's id of the person's own app: events of any other app are dropped. */
  readonly app_id: string;
  readonly verified_at: string;
}

export interface WhatsAppConfig {
  readonly channel: "whatsapp";
  /** The client's own relay on workers.dev (D149). */
  readonly relay_url: string;
  readonly phone_number_id: string;
  readonly display_number: string;
  readonly verified_at: string;
}

export type ChannelConfig = TelegramConfig | EmailConfig | SlackConfig | WhatsAppConfig;
/** Telegram: `{offset}`; email: `{uidvalidity, last_uid}`; Slack: `{seq}`, the last spooled event handled. */
export type Cursor = Readonly<Record<string, number>>;

export interface OutboundFile {
  readonly filename: string;
  readonly type: string;
  readonly bytes: Buffer;
}

export interface OutboundMessage {
  readonly to: string;
  readonly text: string;
  readonly subject?: string;
  /** Email only (D133): saved files from received messages; each was approved by its content hash. */
  readonly attachments?: readonly OutboundFile[];
  /** Email only (D143): the Message-ID this message answers, so it stays in the same conversation. */
  readonly in_reply_to?: string;
}

export interface ChannelConnector {
  readonly id: ChannelId;
  readonly receive: (cursor: Cursor | null, waitSeconds: number, signal: AbortSignal) => Promise<{ readonly messages: readonly RawInbound[]; readonly cursor: Cursor | null }>;
  readonly send: (message: OutboundMessage) => Promise<void>;
  /** Ends a live connection when the gateway stops (Slack, D135). */
  readonly close?: () => Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

export function requireChannelId(id: string | undefined): ChannelId {
  if (!(CHANNEL_IDS as readonly unknown[]).includes(id)) throw new InputError(`Channels: ${CHANNEL_IDS.join(", ")}; for example: taskfollow channel telegram`);
  return id as ChannelId;
}

const configFile = (id: ChannelId): string => join(CHANNELS_DIR, `${id}.json`);
const cursorFile = (id: ChannelId): string => join(CURSORS_DIR, `${id}.cursor.json`);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadChannel(home: string, id: ChannelId): Promise<ChannelConfig | null> {
  const raw = await readConfig(home, configFile(id));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.channel !== id || typeof raw.verified_at !== "string") throw new StateCorruptError(`${configFile(id)} has an unexpected shape; remove it and run 'taskfollow channel ${id}' again`);
  return raw as unknown as ChannelConfig;
}

export const saveChannel = (home: string, config: ChannelConfig): Promise<void> => writeConfig(home, configFile(config.channel), config);

/** The check `channel_verified` (§6.2 CHANNELS): `taskfollow channel <id>` checked the channel live and saved it. */
export async function channelCheck(home: string, id: string): Promise<{ ok: boolean; hint?: string }> {
  const channel = requireChannelId(id);
  if (await loadChannel(home, channel)) return { ok: true };
  const setup = channel === "telegram" ? "store its secret with 'taskfollow secret telegram'" : `let the person finish the page that 'taskfollow secret ${channel}' opens`;
  return { ok: false, hint: `The ${channel} channel is not set up yet: ${setup}, run 'taskfollow channel ${channel}', then run the verify again` };
}

/** The configured channels, in CHANNEL_IDS order. */
export async function listChannels(home: string): Promise<ChannelConfig[]> {
  const found = await Promise.all(CHANNEL_IDS.map((id) => loadChannel(home, id)));
  return found.filter((config): config is ChannelConfig => config !== null);
}

export async function loadCursor(home: string, id: ChannelId): Promise<Cursor | null> {
  const raw = await readConfig(home, cursorFile(id));
  return isRecord(raw) && Object.values(raw).every((value) => typeof value === "number") ? (raw as Cursor) : null;
}

export const saveCursor = (home: string, id: ChannelId, cursor: Cursor): Promise<void> => writeConfig(home, cursorFile(id), cursor);

/** Removes the channel's configuration and read position (`taskfollow disconnect <channel>`). */
export async function removeChannel(home: string, id: ChannelId): Promise<boolean> {
  const existed = (await loadChannel(home, id)) !== null;
  await rm(await confinedPath(home, configFile(id)), { force: true });
  await rm(await confinedPath(home, cursorFile(id)), { force: true });
  return existed;
}

export async function channelSecret(id: ChannelId, env: Env = process.env): Promise<string> {
  const secret = await getSecret(id, env);
  if (secret === null) throw new ActionFailure(`No ${id} secret is stored: run 'taskfollow secret ${id}' and enter it on the page that opens`);
  return secret;
}

function telegramChannel(token: string, env: Env): ChannelConnector {
  const api = telegramApi(token, env);
  return {
    id: "telegram",
    receive: async (cursor, waitSeconds, signal) => {
      const updates = await api.getUpdates(cursor?.offset ?? null, waitSeconds, signal);
      const last = updates.reduce((top, update) => Math.max(top, typeof update.update_id === "number" ? update.update_id : 0), 0);
      const messages = updates.map(telegramInbound).filter((message): message is RawInbound => message !== null);
      return { messages, cursor: last > 0 ? { offset: last + 1 } : cursor };
    },
    send: async (message) => void (await api.sendMessage(message.to, message.text)),
  };
}

/** The connector for a channel's settings and secret; the contract checks run it against fakes and real services (D118). */
export function channelConnector(config: ChannelConfig, secret: string, env: Env = process.env, home?: string): ChannelConnector {
  switch (config.channel) {
    case "telegram":
      return telegramChannel(secret, env);
    case "email":
      return emailChannel(config, secret, env);
    case "slack":
      if (home === undefined) throw new InputError("The Slack channel keeps its events in the install's home: open it with openChannel");
      return slackChannel(config, secret, env, home);
    case "whatsapp":
      if (home === undefined) throw new InputError("The WhatsApp channel records rejected deliveries in the install's home: open it with openChannel");
      return whatsappChannel(config, secret, env, home);
    default:
      return config satisfies never;
  }
}

/** The connector of a configured channel, with its secret from the keychain. */
export async function openChannel(home: string, id: ChannelId, env: Env = process.env): Promise<ChannelConnector> {
  const config = await loadChannel(home, id);
  if (!config) throw new InputError(`The ${id} channel is not set up: run 'taskfollow channel ${id}' first`);
  return channelConnector(config, await channelSecret(id, env), env, home);
}
