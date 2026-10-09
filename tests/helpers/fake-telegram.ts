import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface FakeTelegram {
  readonly url: string;
  /** The env that points the installer's Telegram calls at this server (loopback, with the test file keychain only). */
  readonly env: Readonly<Record<string, string>>;
  /** A person writes to the bot: queues a text message from Telegram user `from`. */
  readonly message: (from: number, text: string) => Promise<void>;
  /** What the bot sent, in order. */
  readonly sent: () => Promise<{ chat_id: string; text: string }[]>;
  readonly calls: () => Promise<Record<string, number>>;
  readonly stop: () => void;
}

/** The bot token tests/fakes/fake-telegram.mjs accepts. */
export const BOT_TOKEN = "123:fake-token";

/** Starts tests/fakes/fake-telegram.mjs in its own process, so a CLI run with spawnSync and a detached gateway can reach it. */
export function startFakeTelegram(): Promise<FakeTelegram> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-telegram.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
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
        message: async (from, text) => void (await fetch(`${url}/debug/updates`, { method: "POST", body: JSON.stringify({ from, text }) })).json(),
        sent: () => get("/debug/sent"), calls: () => get("/debug/calls"), stop: () => void child.kill("SIGKILL"),
      });
    });
    child.once("exit", (code) => fail(new Error(`fake Telegram server exited with ${code}`)));
    child.once("error", fail);
  });
}
