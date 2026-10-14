import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { SLACK_MAX_TEXT, escapeSlack, parseSlackSecret, slackApi, slackInbound } from "../../src/core/slack.js";
import { APP_TOKEN, BOT_TOKEN, SLACK_IDS, startFakeSlack, type FakeSlack } from "../helpers/fake-slack.js";

let fake: FakeSlack;
beforeAll(async () => {
  fake = await startFakeSlack();
});
afterAll(() => fake.stop());

const api = () => slackApi({ bot: BOT_TOKEN, app: APP_TOKEN }, fake.env);

describe("the two Slack tokens (D135)", () => {
  it("reads a bundle with the bot token and the app token", () => {
    expect(parseSlackSecret(JSON.stringify({ bot: "xoxb-1-2-abc", app: "xapp-1-A0-2-abc" }))).toEqual({ bot: "xoxb-1-2-abc", app: "xapp-1-A0-2-abc" });
  });

  it.each([
    [{ bot: "xapp-1", app: "xapp-2" }, "Bot User OAuth Token"],
    [{ bot: "xoxb-1", app: "xoxb-2" }, "App-Level Token"],
    [{ bot: "xoxb-1" }, "App-Level Token"],
    [{ bot: "", app: "xapp-2" }, "Bot User OAuth Token"],
  ])("explains which token is wrong, in plain words, without repeating it", (secret, mention) => {
    let message = "";
    try {
      parseSlackSecret(JSON.stringify(secret));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(mention);
    expect(message).not.toContain("xoxb-1");
  });

  it("refuses text that is not the stored bundle", () => {
    expect(() => parseSlackSecret("nonsense")).toThrow(ActionFailure);
  });
});

describe("what is written to Slack (D135)", () => {
  it("escapes & < > so a message cannot ping everyone or plant a link", () => {
    expect(escapeSlack("Ping <!channel> and <https://evil.example|click> & more")).toBe("Ping &lt;!channel&gt; and &lt;https://evil.example|click&gt; &amp; more");
  });

  it("sends the text escaped, with no automatic parsing, formatting or link previews", async () => {
    await api().postMessage("U0ADA", "Hello <!here> & welcome");
    const [sent] = await fake.sent();
    expect(sent).toMatchObject({ channel: "U0ADA", text: "Hello &lt;!here&gt; &amp; welcome", parse: "none", mrkdwn: false, unfurl_links: false, unfurl_media: false });
    expect(sent?.link_names).toBeUndefined();
  });

  it("cuts a long message to Slack's comfortable limit", async () => {
    await api().postMessage("U0ADA", "x".repeat(SLACK_MAX_TEXT + 500));
    const last = (await fake.sent()).at(-1);
    expect(last?.text.length).toBeLessThanOrEqual(SLACK_MAX_TEXT);
  });

  it("returns the message's timestamp", async () => {
    expect(await api().postMessage("U0ADA", "hi")).toMatch(/^\d+\.\d+$/);
  });

  it("waits out one rate limit and then sends", async () => {
    expect(await api().postMessage("RATE", "after the wait")).toMatch(/^\d+\.\d+$/);
  });

  it("explains an unknown person plainly", async () => {
    await expect(api().postMessage("UNKNOWN", "hi")).rejects.toThrow("has not opened a chat");
  });
});

describe("checking the tokens (D135)", () => {
  it("reads the workspace and the bot's own user id with the bot token", async () => {
    expect(await api().authTest()).toMatchObject({ team_id: SLACK_IDS.team_id, team: SLACK_IDS.team, bot_user_id: SLACK_IDS.bot_user_id });
  });

  it("gets a socket address with the app token", async () => {
    expect(await api().connectionsOpen()).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/link/);
  });

  it("says the app was removed or its token changed, and never prints a token", async () => {
    const bad = slackApi({ bot: "xoxb-wrong", app: "xapp-wrong" }, fake.env);
    await expect(bad.authTest()).rejects.toThrow("taskfollow secret slack");
    await expect(bad.connectionsOpen()).rejects.toThrow("taskfollow secret slack");
    try {
      await bad.authTest();
    } catch (error) {
      expect((error as Error).message).not.toContain("xoxb-wrong");
    }
  });
});

describe("which events become messages (D135)", () => {
  const CONFIG = { team_id: SLACK_IDS.team_id, bot_user_id: SLACK_IDS.bot_user_id, app_id: SLACK_IDS.app_id };
  const payload = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ team_id: "T0TEAM", api_app_id: "A0APP", event: { type: "message", channel_type: "im", user: "U0ADA", text: "JOIN ABCDE-FGHIJ", channel: "D0ADA", ts: "1700000100.000001", ...event }, ...extra });

  it("keeps a person's direct message, with the user as sender and the conversation as thread", () => {
    expect(slackInbound(payload({}), CONFIG)).toEqual({ channel: "slack", from: "U0ADA", thread: "D0ADA", text: "JOIN ABCDE-FGHIJ", message_id: "D0ADA:1700000100.000001" });
  });

  it.each([
    ["an edited or system message (subtype)", { subtype: "message_changed" }],
    ["a bot's message", { bot_id: "B0OTHER" }],
    ["the assistant's own message", { user: "U0BOT" }],
    ["a channel message", { channel_type: "channel" }],
    ["a message without text", { text: undefined }],
    ["a message without a sender", { user: undefined }],
  ])("drops %s", (_what, event) => {
    expect(slackInbound(payload(event), CONFIG)).toBeNull();
  });

  it("drops events of another workspace or another app, which also catches tokens from two different apps", () => {
    expect(slackInbound(payload({}, { team_id: "T0OTHER" }), CONFIG)).toBeNull();
    expect(slackInbound(payload({}, { api_app_id: "A0OTHER" }), CONFIG)).toBeNull();
  });

  it("drops anything that is not an event payload", () => {
    expect(slackInbound(null, CONFIG)).toBeNull();
    expect(slackInbound({ event: "no" }, CONFIG)).toBeNull();
  });
});
