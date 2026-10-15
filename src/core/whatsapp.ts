import { createHmac, timingSafeEqual } from "node:crypto";
import { connectorUrl } from "./connectors.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";

/**
 * WhatsApp, customer-facing (D149). The relay file the deployer uploads to the client's own Cloudflare account must be
 * exactly the one shipped in the package: its sha256 is pinned here and checked before every upload.
 */
export const RELAY_FILE = "relay/whatsapp-relay.mjs";
export const RELAY_SHA256 = "db29195a36e5d28935486bff7a1284d2f789c7e150a4a5afeb27f54111d0d3ff";


type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const GRAPH_API = "https://graph.facebook.com/v25.0";
export const WHATSAPP_SECRET_ID = "whatsapp";
export const WHATSAPP_MAX_TEXT = 4096;
const CALL_TIMEOUT_MS = 30_000;
/** A WhatsApp username's business-scoped id: a country code, a dot, digits (Meta, April 2026). */
const USER_ID = /^[A-Z]{2}\.\d{6,}$/;
const RELAY_ADDRESS = /^https:\/\/taskfollow-whatsapp\.[a-z0-9-]+\.workers\.dev$/;

export interface WhatsAppSecrets {
  readonly access_token: string;
  readonly app_secret: string;
  readonly pull_token: string;
}

export function parseWhatsAppSecret(text: string): WhatsAppSecrets {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ActionFailure("The stored WhatsApp sign-in is damaged: run 'taskfollow secret whatsapp' again");
  }
  const secrets = isRecord(raw) ? { access_token: str(raw.access_token), app_secret: str(raw.app_secret), pull_token: str(raw.pull_token) } : null;
  if (!secrets || !secrets.access_token || !secrets.app_secret || !secrets.pull_token) throw new ActionFailure("The stored WhatsApp sign-in is incomplete: run 'taskfollow secret whatsapp' again");
  return secrets;
}

/** Meta signs the exact bytes it posted with the app secret; anything else is refused (checked before reading them). */
export function verifySignature(bytes: Buffer, header: string, appSecret: string): boolean {
  if (!header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(bytes).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? "an" : "a");

/** The customers' messages in one delivery for this business number; receipts and other numbers' messages are dropped. */
export function parseDelivery(payload: unknown, phoneNumberId: string): RawInbound[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];
  const messages: RawInbound[] = [];
  for (const entry of payload.entry) {
    for (const change of isRecord(entry) && Array.isArray(entry.changes) ? entry.changes : []) {
      const value = isRecord(change) && isRecord(change.value) ? change.value : {};
      if (!isRecord(value.metadata) || value.metadata.phone_number_id !== phoneNumberId) continue;
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (!isRecord(message)) continue;
        const from = str(message.from_user_id) || str(message.from);
        const id = str(message.id);
        if (!from || !id) continue;
        const type = str(message.type) || "message";
        const text = type === "text" && isRecord(message.text) ? str(message.text.body) : `(sent ${article(type)} ${type}: open WhatsApp to see it)`;
        const seconds = Number(message.timestamp);
        messages.push({ channel: "whatsapp", from, thread: from, text, message_id: id, ...(Number.isFinite(seconds) && seconds > 0 ? { sent_at: new Date(seconds * 1000).toISOString() } : {}) });
      }
    }
  }
  return messages;
}

export const recipientField = (address: string): Readonly<Record<string, string>> => (USER_ID.test(address) ? { recipient: address } : { to: address });
export const isWhatsAppAddress = (address: string): boolean => /^\d{8,15}$/.test(address) || USER_ID.test(address);

const PLAIN: Readonly<Record<number, string>> = {
  131047: "WhatsApp only lets a business reply within 24 hours of the customer's last message, and that time has passed: ask them to write again, or use another channel",
  190: "Meta no longer accepts the WhatsApp access token: run 'taskfollow secret whatsapp' again",
  131030: "This number is not on the test number's list of allowed recipients in Meta's settings",
  131026: "This WhatsApp message could not be delivered (the number may not use WhatsApp)",
};

async function graph(token: string, path: string, init: { method: "GET" | "POST"; body?: unknown }, env: Env): Promise<Raw> {
  let response: Response;
  try {
    response = await fetch(connectorUrl(`${GRAPH_API}${path}`, env), {
      method: init.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach WhatsApp (${(error as Error).message})`);
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok && isRecord(json)) return json;
  const code = isRecord(json) && isRecord(json.error) && typeof json.error.code === "number" ? json.error.code : 0;
  throw new ActionFailure(PLAIN[code] ?? `WhatsApp refused the request (error ${code || response.status})`);
}

export function whatsappApi(secrets: WhatsAppSecrets, phoneNumberId: string, env: Env = process.env) {
  return {
    phoneInfo: async (): Promise<{ readonly display_number: string; readonly name: string }> => {
      const info = await graph(secrets.access_token, `/${phoneNumberId}?fields=display_phone_number,verified_name`, { method: "GET" }, env);
      return { display_number: str(info.display_phone_number), name: str(info.verified_name) };
    },
    send: async (address: string, text: string): Promise<void> => {
      await graph(secrets.access_token, `/${phoneNumberId}/messages`, { method: "POST", body: { messaging_product: "whatsapp", ...recipientField(address), type: "text", text: { body: text.slice(0, WHATSAPP_MAX_TEXT), preview_url: false } } }, env);
    },
  };
}

export interface RelayItem {
  readonly id: number;
  readonly body_b64: string;
  readonly signature: string;
  readonly received_at: number;
}

/** Only the client's own relay on workers.dev; a loopback address only for tests with the throwaway keychain. */
function relayAllowed(url: string, env: Env): boolean {
  if (RELAY_ADDRESS.test(url)) return true;
  return env.INSTALLER_KEYCHAIN === "file" && !!env.INSTALLER_CONNECTOR_SERVER && url === env.INSTALLER_CONNECTOR_SERVER;
}

export async function pullRelay(relayUrl: string, pullToken: string, after: number, env: Env = process.env): Promise<RelayItem[]> {
  if (!relayAllowed(relayUrl, env)) throw new ActionFailure("The WhatsApp relay address is not a workers.dev address of TaskFollow's relay: run 'taskfollow secret whatsapp' again");
  let response: Response;
  try {
    response = await fetch(`${relayUrl}/pull?after=${after}`, { headers: { authorization: `Bearer ${pullToken}` }, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  } catch (error) {
    throw new ActionFailure(`Cannot reach the WhatsApp relay (${(error as Error).message})`);
  }
  if (response.status === 401) throw new ActionFailure("The WhatsApp relay refused the pull token: run 'taskfollow secret whatsapp' again");
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(json) || !Array.isArray(json.items)) throw new ActionFailure(`The WhatsApp relay answered ${response.status}`);
  return json.items.filter((item): item is RelayItem => isRecord(item) && typeof item.id === "number" && typeof item.body_b64 === "string" && typeof item.signature === "string");
}
