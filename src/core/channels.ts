import { rm } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { readConfig, writeConfig } from "./data-source.js";
import { emailChannel } from "./email-channel.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import type { MailAccount } from "./smtp.js";
import { StateCorruptError } from "./state.js";
import { telegramApi, telegramInbound, type TelegramBot } from "./telegram.js";

/**
 * Channel connectors (spec §12.2, D73): one interface, receive + send + declared capabilities. v1 has two built-in
 * adapters, Telegram and email, configured by `installer channel <id>` into `config/channels/<id>.json` (no secrets:
 * the bot token and the app password stay in the keychain items `telegram` and `email`). The gateway keeps each
 * channel's read position in `state/gateway/<id>.cursor.json`.
 */
export const CHANNEL_IDS = ["telegram", "email"] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];
export const CHANNELS_DIR = join("config", "channels");
export const CURSORS_DIR = join("state", "gateway");

export interface ChannelCapabilities {
  readonly buttons: boolean;
  readonly attachments: readonly string[];
  readonly reply_window: "none" | "24h";
  readonly inbound: "long_poll" | "webhook" | "imap_poll";
}

export interface ChannelRisk {
  readonly official_api: boolean;
  readonly outbound_external: boolean;
  /** The platform proves who sent a message (a Telegram user id). An email's From line can be forged, so it cannot (D78). */
  readonly sender_verified: boolean;
}

/** v1 uses reply codes (buttons later) and stores no attachments. */
export const CHANNEL_FACTS: Readonly<Record<ChannelId, { readonly capabilities: ChannelCapabilities; readonly risk: ChannelRisk }>> = {
  telegram: { capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "long_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: true } },
  email: { capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "imap_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: false } },
};

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

export type ChannelConfig = TelegramConfig | EmailConfig;
/** Telegram: `{offset}`; email: `{uidvalidity, last_uid}`. */
export type Cursor = Readonly<Record<string, number>>;

export interface OutboundMessage {
  readonly to: string;
  readonly text: string;
  readonly subject?: string;
}

export interface ChannelConnector {
  readonly id: ChannelId;
  readonly receive: (cursor: Cursor | null, waitSeconds: number, signal: AbortSignal) => Promise<{ readonly messages: readonly RawInbound[]; readonly cursor: Cursor | null }>;
  readonly send: (message: OutboundMessage) => Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

export function requireChannelId(id: string | undefined): ChannelId {
  if (!(CHANNEL_IDS as readonly unknown[]).includes(id)) throw new InputError(`Channels: ${CHANNEL_IDS.join(", ")}; for example: installer channel telegram`);
  return id as ChannelId;
}

const configFile = (id: ChannelId): string => join(CHANNELS_DIR, `${id}.json`);
const cursorFile = (id: ChannelId): string => join(CURSORS_DIR, `${id}.cursor.json`);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadChannel(home: string, id: ChannelId): Promise<ChannelConfig | null> {
  const raw = await readConfig(home, configFile(id));
  if (raw === null) return null;
  if (!isRecord(raw) || raw.channel !== id || typeof raw.verified_at !== "string") throw new StateCorruptError(`${configFile(id)} has an unexpected shape; remove it and run 'installer channel ${id}' again`);
  return raw as unknown as ChannelConfig;
}

export const saveChannel = (home: string, config: ChannelConfig): Promise<void> => writeConfig(home, configFile(config.channel), config);

/** The check `channel_verified` (§6.2 CHANNELS): `installer channel <id>` checked the channel live and saved it. */
export async function channelCheck(home: string, id: string): Promise<{ ok: boolean; hint?: string }> {
  const channel = requireChannelId(id);
  if (await loadChannel(home, channel)) return { ok: true };
  const command = channel === "email" ? "installer channel email --value '<servers>'" : "installer channel telegram";
  return { ok: false, hint: `The ${channel} channel is not set up yet: store its secret with 'installer secret ${channel}', run '${command}', then run the verify again` };
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

/** Removes the channel's configuration and read position (`installer disconnect <channel>`). */
export async function removeChannel(home: string, id: ChannelId): Promise<boolean> {
  const existed = (await loadChannel(home, id)) !== null;
  await rm(await confinedPath(home, configFile(id)), { force: true });
  await rm(await confinedPath(home, cursorFile(id)), { force: true });
  return existed;
}

export async function channelSecret(id: ChannelId, env: Env = process.env): Promise<string> {
  const secret = await getSecret(id, env);
  if (secret === null) throw new ActionFailure(`No ${id} secret is stored: run 'installer secret ${id}' and enter it on the page that opens`);
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
export function channelConnector(config: ChannelConfig, secret: string, env: Env = process.env): ChannelConnector {
  return config.channel === "telegram" ? telegramChannel(secret, env) : emailChannel(config, secret, env);
}

/** The connector of a configured channel, with its secret from the keychain. */
export async function openChannel(home: string, id: ChannelId, env: Env = process.env): Promise<ChannelConnector> {
  const config = await loadChannel(home, id);
  if (!config) throw new InputError(`The ${id} channel is not set up: run 'installer channel ${id}' first`);
  return channelConnector(config, await channelSecret(id, env), env);
}
