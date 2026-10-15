import { setTimeout as sleep } from "node:timers/promises";
import { appendAudit } from "./audit.js";
import type { ChannelConnector, Cursor, WhatsAppConfig } from "./channels.js";
import type { RawInbound } from "./envelope.js";
import { parseDelivery, parseWhatsAppSecret, pullRelay, verifySignature, whatsappApi } from "./whatsapp.js";

/**
 * The WhatsApp connector (D149). Receiving pulls from the client's relay; when nothing waits it pulls again every
 * 10 seconds until the gateway's wait ends. Each delivery is checked against Meta's signature on its exact bytes
 * before it is read; a delivery that fails is dropped and audited (`channel.signature_rejected`). The cursor is the
 * relay id of the last delivery handled, which also tells the relay it may forget it. Sending is plain text.
 */
type Env = Readonly<Record<string, string | undefined>>;
const POLL_MS = 10_000;

export function whatsappChannel(config: WhatsAppConfig, secret: string, env: Env, home: string): ChannelConnector {
  const secrets = parseWhatsAppSecret(secret);
  const api = whatsappApi(secrets, config.phone_number_id, env);
  const readOnce = async (after: number): Promise<{ messages: RawInbound[]; last: number }> => {
    const items = await pullRelay(config.relay_url, secrets.pull_token, after, env);
    const messages: RawInbound[] = [];
    for (const item of items) {
      const bytes = Buffer.from(item.body_b64, "base64");
      if (!verifySignature(bytes, item.signature, secrets.app_secret)) {
        await appendAudit(home, { ts: new Date().toISOString(), actor: "engine", event: "channel.signature_rejected", ref: "whatsapp", payload: { relay_id: item.id, size: bytes.length } });
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(bytes.toString("utf8"));
      } catch {
        continue;
      }
      messages.push(...parseDelivery(payload, config.phone_number_id));
    }
    return { messages, last: items.at(-1)?.id ?? after };
  };
  return {
    id: "whatsapp",
    receive: async (cursor: Cursor | null, waitSeconds: number, signal: AbortSignal) => {
      const end = Date.now() + waitSeconds * 1000;
      let after = cursor?.after ?? 0;
      for (;;) {
        const read = await readOnce(after);
        after = read.last;
        if (read.messages.length > 0 || Date.now() >= end || signal.aborted) return { messages: read.messages, cursor: { after } };
        await sleep(Math.min(POLL_MS, Math.max(0, end - Date.now())), undefined, { signal }).catch(() => undefined);
      }
    },
    send: async (message) => api.send(message.to, message.text),
  };
}
