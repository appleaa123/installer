import { spawn } from "node:child_process";
import { resolve } from "node:path";

export const WA = { token: "EAAfake-token", secret: "app-secret-fake", phone_id: "1098765", pull: "pull-fake", verify: "verify-fake", path_key: "a".repeat(32) } as const;

export interface FakeWhatsApp {
  readonly url: string;
  /** Points Graph calls at this server (loopback, test file keychain only); the relay address is `url` itself. */
  readonly env: Readonly<Record<string, string>>;
  /** Meta delivers a webhook payload to the relay, signed with the app secret (or wrongly, or not at all). */
  readonly deliver: (payload: unknown, sign?: "good" | "wrong" | "none") => Promise<{ status: number }>;
  readonly sent: () => Promise<Record<string, unknown>[]>;
  readonly pulls: () => Promise<number>;
  readonly stop: () => void;
}

/** Starts tests/fakes/fake-whatsapp.mjs in its own process, so a spawned CLI and a detached gateway can reach it. */
export function startFakeWhatsApp(): Promise<FakeWhatsApp> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-whatsapp.mjs")], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { url } = JSON.parse(buffer.slice(0, newline)) as { url: string };
      const get = async <T>(path: string): Promise<T> => (await fetch(`${url}${path}`)).json() as Promise<T>;
      done({
        url, env: { INSTALLER_CONNECTOR_SERVER: url, INSTALLER_KEYCHAIN: "file" },
        deliver: async (payload, sign = "good") => (await fetch(`${url}/debug/deliver`, { method: "POST", body: JSON.stringify({ payload, sign }) })).json() as Promise<{ status: number }>,
        sent: () => get("/debug/sent"), pulls: async () => (await get<{ pulls: number }>("/debug/pulls")).pulls, stop: () => void child.kill("SIGKILL"),
      });
    });
    child.on("error", fail);
  });
}

/** A Meta webhook payload with one text message (or `type` other than text), as the Cloud API sends it. */
export function textPayload(fields: { from?: string; from_user_id?: string; text?: string; id?: string; timestamp?: number; phone_id?: string; type?: string } = {}): unknown {
  const type = fields.type ?? "text";
  const message = {
    ...(fields.from === undefined && fields.from_user_id !== undefined ? {} : { from: fields.from ?? "15550001111" }),
    ...(fields.from_user_id ? { from_user_id: fields.from_user_id } : {}),
    id: fields.id ?? "wamid.in1", timestamp: String(fields.timestamp ?? 1_760_436_000), type,
    ...(type === "text" ? { text: { body: fields.text ?? "Where is my order #1001?" } } : { [type]: { id: "media1" } }),
  };
  return { object: "whatsapp_business_account", entry: [{ id: "waba1", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550100", phone_number_id: fields.phone_id ?? WA.phone_id }, contacts: [{ profile: { name: "Sam" }, wa_id: fields.from ?? "15550001111" }], messages: [message] } }] }] };
}
