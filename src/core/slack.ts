import { setTimeout as sleep } from "node:timers/promises";
import { connectorUrl } from "./connectors.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";

/**
 * The Slack Web API through `fetch`, nothing else (D135): `auth.test` and `chat.postMessage` with the bot token
 * (`xoxb-`), and `apps.connections.open` with the app-level token (`xapp-`), which gives the address of the live
 * connection Socket Mode uses (slack-socket.ts). The two tokens live in one keychain item, `slack`, and never appear
 * in an error, a log line or the audit. Tests point the API at a loopback fake with INSTALLER_CONNECTOR_SERVER.
 */
export const SLACK_API = "https://slack.com/api";
export const SLACK_SECRET_ID = "slack";
/** Slack accepts up to 40,000 characters and cuts at 4,000 for display; stay under the display limit. */
export const SLACK_MAX_TEXT = 4000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_RETRY_WAIT_S = 30;
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export interface SlackTokens {
  readonly bot: string;
  readonly app: string;
}

/** What the page and `channel slack` save about the workspace, to recognise the right events later. */
export interface SlackIdentity {
  readonly team_id: string;
  readonly team: string;
  readonly bot_user_id: string;
}

export interface SlackApi {
  readonly authTest: () => Promise<SlackIdentity>;
  /** The address of a Socket Mode connection (single use). */
  readonly connectionsOpen: () => Promise<string>;
  /** Posts a direct message (a user id as the channel opens it); returns the message's timestamp. */
  readonly postMessage: (channel: string, text: string) => Promise<string>;
}

/** The stored bundle `{ bot, app }`, each checked by its prefix so a swapped or wrong token is named plainly. */
export function parseSlackSecret(text: string): SlackTokens {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ActionFailure("The stored Slack sign-in is damaged: run 'taskfollow secret slack' again");
  }
  const bot = isRecord(raw) && typeof raw.bot === "string" ? raw.bot.trim() : "";
  const app = isRecord(raw) && typeof raw.app === "string" ? raw.app.trim() : "";
  if (!bot.startsWith("xoxb-")) throw new ActionFailure("The Slack Bot User OAuth Token is missing or wrong: it starts with xoxb-. Run 'taskfollow secret slack' and paste it again");
  if (!app.startsWith("xapp-")) throw new ActionFailure("The Slack App-Level Token is missing or wrong: it starts with xapp-. Run 'taskfollow secret slack' and paste it again");
  return { bot, app };
}

/** `& < >` as entities: with parse "none" this stops <!channel>, <!here> and <url|text> links in an AI-written message. */
export const escapeSlack = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PLAIN: Readonly<Record<string, string>> = {
  channel_not_found: "This person has not opened a chat with the Slack app yet: ask them to send it a message in Slack first",
  not_in_channel: "This person has not opened a chat with the Slack app yet: ask them to send it a message in Slack first",
  invalid_auth: "The Slack app was removed or its token changed: run 'taskfollow secret slack' again",
  token_revoked: "The Slack app was removed or its token changed: run 'taskfollow secret slack' again",
  account_inactive: "The Slack app was removed or its token changed: run 'taskfollow secret slack' again",
  not_authed: "The Slack app was removed or its token changed: run 'taskfollow secret slack' again",
  is_archived: "That Slack conversation is archived",
  restricted_action: "Slack does not let the app write there (a workspace setting)",
  ratelimited: "Slack asked the assistant to slow down; it will try again in a minute",
};

function failure(method: string, code: string): ActionFailure {
  return new ActionFailure(PLAIN[code] ?? `Slack refused ${method} (${code.slice(0, 60)})`);
}

async function call(token: string, method: string, body: Raw, env: Env, attempt = 0): Promise<Raw> {
  let response: Response;
  try {
    response = await fetch(connectorUrl(`${SLACK_API}/${method}`, env), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Slack (${(error as Error).message})`);
  }
  if (response.status === 429) {
    const wait = Number(response.headers.get("retry-after") ?? "1");
    if (attempt === 0 && Number.isFinite(wait) && wait <= MAX_RETRY_WAIT_S) {
      await sleep(wait * 1000);
      return call(token, method, body, env, 1);
    }
    throw failure(method, "ratelimited");
  }
  const json: unknown = await response.json().catch(() => null);
  if (isRecord(json) && json.ok === true) return json;
  throw failure(method, isRecord(json) && typeof json.error === "string" ? json.error : `HTTP ${response.status}`);
}

export function slackApi(tokens: SlackTokens, env: Env = process.env): SlackApi {
  return {
    authTest: async () => {
      const result = await call(tokens.bot, "auth.test", {}, env);
      if (typeof result.team_id !== "string" || typeof result.user_id !== "string") throw new ActionFailure("Slack answered auth.test without a workspace");
      return { team_id: result.team_id, team: typeof result.team === "string" ? result.team : result.team_id, bot_user_id: result.user_id };
    },
    connectionsOpen: async () => {
      const result = await call(tokens.app, "apps.connections.open", {}, env);
      if (typeof result.url !== "string") throw new ActionFailure("Slack gave no address for the live connection: check that Socket Mode is on for the app");
      return result.url;
    },
    postMessage: async (channel, text) => {
      const result = await call(tokens.bot, "chat.postMessage", {
        channel, text: escapeSlack(text).slice(0, SLACK_MAX_TEXT), parse: "none", mrkdwn: false, unfurl_links: false, unfurl_media: false,
      }, env);
      return typeof result.ts === "string" ? result.ts : "";
    },
  };
}

/**
 * A direct message from a person, as the gateway's raw inbound; anything else is null: edits and system messages (a
 * subtype), bots, the assistant itself, channel messages, and any event of another workspace or another app (which also
 * catches a bot token and an app token taken from two different apps). `user` is set by Slack on a connection that
 * was opened with the client's own app token, so the sender is proven (D135).
 */
export function slackInbound(payload: unknown, config: { readonly team_id: string; readonly bot_user_id: string; readonly app_id: string }): RawInbound | null {
  if (!isRecord(payload) || payload.team_id !== config.team_id || payload.api_app_id !== config.app_id || !isRecord(payload.event)) return null;
  const event = payload.event;
  if (event.type !== "message" || event.channel_type !== "im" || event.subtype !== undefined || event.bot_id !== undefined) return null;
  const { user, text, channel, ts } = event;
  if (typeof user !== "string" || typeof text !== "string" || typeof channel !== "string" || typeof ts !== "string" || user === config.bot_user_id) return null;
  return { channel: "slack", from: user, thread: channel, text, message_id: `${channel}:${ts}` };
}
