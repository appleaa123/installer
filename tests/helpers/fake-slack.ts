import { spawn } from "node:child_process";
import { resolve } from "node:path";

export const BOT_TOKEN = "xoxb-fake-bot";
export const APP_TOKEN = "xapp-fake-app";
/** What the fake reports, and what the saved config must hold for an event to be accepted. */
export const SLACK_IDS = { team_id: "T0TEAM", team: "Fake Team", bot_user_id: "U0BOT", app_id: "A0APP" } as const;

export interface FakeSlack {
  readonly url: string;
  /** The env that points the installer's Slack calls at this server (loopback, with the test file keychain only). */
  readonly env: Readonly<Record<string, string>>;
  /** A person sends the bot a direct message; extra fields (subtype, bot_id, team_id, …) are passed through. */
  readonly event: (fields: Record<string, unknown>) => Promise<{ envelope_id: string; ts: string }>;
  readonly redeliver: () => Promise<void>;
  readonly disconnect: (reason?: string) => Promise<void>;
  readonly drop: () => Promise<void>;
  readonly acks: () => Promise<string[]>;
  readonly sent: () => Promise<{ channel: string; text: string; parse?: string; mrkdwn?: boolean; unfurl_links?: boolean; link_names?: boolean }[]>;
  readonly stats: () => Promise<{ opens: number; live: number; acks: number }>;
  readonly stop: () => void;
}

/** Starts tests/fakes/fake-slack.mjs in its own process, so a spawned CLI and a detached gateway can reach it. */
export function startFakeSlack(): Promise<FakeSlack> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-slack.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { url } = JSON.parse(buffer.slice(0, newline)) as { url: string };
      const post = async <T>(path: string, body: unknown = {}): Promise<T> => (await fetch(`${url}${path}`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<T>;
      const get = async <T>(path: string): Promise<T> => (await fetch(`${url}${path}`)).json() as Promise<T>;
      done({
        url, env: { INSTALLER_CONNECTOR_SERVER: url, INSTALLER_KEYCHAIN: "file" },
        event: (fields) => post("/debug/event", fields), redeliver: () => post("/debug/redeliver"), disconnect: (reason = "warning") => post("/debug/disconnect", { reason }), drop: () => post("/debug/drop"),
        acks: () => get("/debug/acks"), sent: () => get("/debug/sent"), stats: () => get("/debug/stats"), stop: () => void child.kill("SIGKILL"),
      });
    });
    child.once("exit", (code) => fail(new Error(`fake Slack server exited with ${code}`)));
    child.once("error", fail);
  });
}
