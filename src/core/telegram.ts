import { connectorUrl } from "./connectors.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";

/**
 * The Telegram Bot API through `fetch`, nothing else (D74): `getMe`, `getUpdates` (long polling; no webhook and no
 * tunnel in v1, O4) and `sendMessage`. The bot token lives in the keychain item `telegram` and appears only in
 * the request path, never in an error, a log line or the audit. Tests point the API at a loopback fake with
 * INSTALLER_CONNECTOR_SERVER (D65).
 */
export const TELEGRAM_API = "https://api.telegram.org";
export const TELEGRAM_SECRET_ID = "telegram";
/** Telegram's own limit for one message. */
export const TELEGRAM_MAX_TEXT = 4096;
const CALL_TIMEOUT_MS = 30_000;
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export interface TelegramBot {
  readonly id: number;
  readonly username: string;
}

export interface TelegramApi {
  readonly getMe: () => Promise<TelegramBot>;
  /** Updates from `offset` on (earlier ones are confirmed and dropped by Telegram); [] when `signal` aborts. */
  readonly getUpdates: (offset: number | null, timeoutSeconds: number, signal?: AbortSignal) => Promise<readonly Raw[]>;
  readonly sendMessage: (chatId: string, text: string) => Promise<number>;
}

function refusal(method: string, body: unknown, status: number): ActionFailure {
  const code = isRecord(body) && typeof body.error_code === "number" ? body.error_code : status;
  const description = isRecord(body) && typeof body.description === "string" ? body.description.slice(0, 200) : `HTTP ${status}`;
  if (code === 401 || code === 404) return new ActionFailure("Telegram refused the bot token: if the bot was deleted or its token revoked, get a new token from @BotFather, then run 'taskfollow secret telegram'");
  if (code === 409) return new ActionFailure("Another program is reading this bot's updates (a webhook, or a second gateway): stop it, then try again");
  return new ActionFailure(`Telegram refused ${method} (${code}: ${description})`);
}

async function call(token: string, method: string, body: Raw, env: Env, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let response: Response;
  try {
    response = await fetch(connectorUrl(`${TELEGRAM_API}/bot${token}/${method}`, env), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (signal?.aborted) return null;
    throw new ActionFailure(`Cannot reach Telegram (${(error as Error).message})`);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok && isRecord(json) && json.ok === true) return json.result;
  throw refusal(method, json, response.status);
}

export function telegramApi(token: string, env: Env = process.env): TelegramApi {
  return {
    getMe: async () => {
      const result = await call(token, "getMe", {}, env, CALL_TIMEOUT_MS);
      if (!isRecord(result) || typeof result.id !== "number" || typeof result.username !== "string") throw new ActionFailure("Telegram answered getMe without a bot");
      return { id: result.id, username: result.username };
    },
    getUpdates: async (offset, timeoutSeconds, signal) => {
      const body = { timeout: timeoutSeconds, allowed_updates: ["message"], ...(offset === null ? {} : { offset }) };
      const result = await call(token, "getUpdates", body, env, CALL_TIMEOUT_MS + timeoutSeconds * 1000, signal);
      return Array.isArray(result) ? result.filter(isRecord) : [];
    },
    sendMessage: async (chatId, text) => {
      const result = await call(token, "sendMessage", { chat_id: chatId, text: text.slice(0, TELEGRAM_MAX_TEXT) }, env, CALL_TIMEOUT_MS);
      return isRecord(result) && typeof result.message_id === "number" ? result.message_id : 0;
    },
  };
}

/** A text message from a person, as the gateway's raw inbound; anything else (bots, stickers, edits) is null. */
export function telegramInbound(update: Raw): RawInbound | null {
  const message = isRecord(update.message) ? update.message : null;
  const from = message && isRecord(message.from) ? message.from : null;
  const chat = message && isRecord(message.chat) ? message.chat : null;
  const text = typeof message?.text === "string" ? message.text : typeof message?.caption === "string" ? message.caption : "";
  if (!from || !chat || from.is_bot === true || text.trim() === "" || typeof update.update_id !== "number") return null;
  return { channel: "telegram", from: String(from.id), thread: String(chat.id), text, message_id: String(update.update_id) };
}
