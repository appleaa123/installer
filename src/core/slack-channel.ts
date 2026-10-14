import { join } from "node:path";
import type { ChannelConnector, SlackConfig } from "./channels.js";
import type { RawInbound } from "./envelope.js";
import { ActionFailure } from "./failure.js";
import { parseSlackSecret, slackApi, slackInbound } from "./slack.js";
import { SlackSocket } from "./slack-socket.js";

/**
 * The Slack channel (D135): direct messages to the assistant's app, read over one live connection (Socket Mode) and sent
 * with chat.postMessage. Events wait in a spool under `state/gateway/slack/`; the cursor is the last spooled event the
 * gateway handled. It reaches the client's own team only. The connection starts at the first `receive`, so sending alone
 * (a notification from a workflow) never opens one.
 */
type Env = Readonly<Record<string, string | undefined>>;
const SLACK_ID = /^[UWD][A-Z0-9]{2,}$/;

export function slackChannel(config: SlackConfig, secret: string, env: Env, home: string): ChannelConnector {
  const tokens = parseSlackSecret(secret);
  const api = slackApi(tokens, env);
  const socket = new SlackSocket({
    api, env, spoolDir: join(home, "state", "gateway", "slack"),
    // Loaded when needed: the gateway imports the channels, which import this file.
    log: (message) => void import("./gateway.js").then(({ gatewayLog }) => gatewayLog(home, new Date().toISOString(), { level: "warn", loop: "slack", error: message })).catch(() => undefined),
  });
  return {
    id: "slack",
    receive: async (cursor, waitSeconds, signal) => {
      const events = await socket.receive(cursor?.seq ?? 0, waitSeconds, signal);
      const messages = events.map((event) => slackInbound(event.payload, config)).filter((message): message is RawInbound => message !== null);
      const last = events.at(-1)?.seq;
      return { messages, cursor: last === undefined ? cursor : { seq: last } };
    },
    send: async (message) => {
      const to = message.to.toUpperCase();
      if (!SLACK_ID.test(to)) throw new ActionFailure(`'${message.to.slice(0, 40)}' is not a Slack user: members join by sending the app a message`);
      await api.postMessage(to, message.text);
    },
    close: () => socket.close(),
  };
}
