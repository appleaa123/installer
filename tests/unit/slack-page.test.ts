import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import type { SecretPage } from "../../src/core/secret-page.js";
import { SLACK_MANIFEST, startSlackPage, type SlackSettings } from "../../src/core/slack-page.js";
import type { SlackTokens } from "../../src/core/slack.js";
import { APP_TOKEN, BOT_TOKEN, SLACK_IDS, startFakeSlack, type FakeSlack } from "../helpers/fake-slack.js";
import { formHeaders, request } from "../helpers/http.js";

let fake: FakeSlack;
const pages: SecretPage[] = [];
beforeAll(async () => {
  fake = await startFakeSlack();
});
afterAll(() => fake.stop());
afterEach(() => pages.splice(0).forEach((open) => open.close()));

interface Recorder {
  readonly stored: [string, string][];
  readonly checked: SlackTokens[];
}

async function page(check?: (tokens: SlackTokens) => Promise<SlackSettings>, ttlMs?: number) {
  const rec: Recorder = { stored: [], checked: [] };
  const started = await startSlackPage({
    store: async (id, value) => void rec.stored.push([id, value]),
    ...(check ? { check: async (tokens: SlackTokens) => (rec.checked.push(tokens), check(tokens)) } : {}),
    env: fake.env,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  pages.push(started);
  return { url: started.url, rec, done: started.done };
}
const post = (url: string, fields: Record<string, string>) => request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: new URLSearchParams(fields).toString() });
const GOOD = { bot: BOT_TOKEN, app: APP_TOKEN };
const SETTINGS: SlackSettings = { team_id: "T0TEAM", team: "Fake Team", bot_user_id: "U0BOT", app_id: "A0APP" };

describe("the Slack setup page (D135)", () => {
  it("shows the manifest to copy and asks for two tokens, on a one-time path", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("<textarea");
    expect(reply.text).toContain("socket_mode_enabled");
    expect(reply.text).toContain('<input type="password" name="bot"');
    expect(reply.text).toContain('<input type="password" name="app"');
    expect(reply.text).toContain("Request to Install");
    expect(reply.text).toContain("connections:write");
  });

  it("asks for only the scopes and the one event the assistant needs", () => {
    const manifest = JSON.parse(SLACK_MANIFEST) as { oauth_config: { scopes: { bot: string[] } }; settings: { socket_mode_enabled: boolean; event_subscriptions: { bot_events: string[] } } };
    expect(manifest.oauth_config.scopes.bot.sort()).toEqual(["chat:write", "im:history", "im:write"]);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(["message.im"]);
    expect(manifest.settings.socket_mode_enabled).toBe(true);
  });

  it("tells which token has the wrong beginning, without testing anything", async () => {
    const { url, rec } = await page(async () => SETTINGS);
    const swapped = await post(url, { bot: APP_TOKEN, app: BOT_TOKEN });
    expect(swapped.status).toBe(400);
    expect(swapped.text).toContain("xoxb-");
    expect(rec.checked).toEqual([]);
    expect(rec.stored).toEqual([]);
    expect((await post(url, { bot: BOT_TOKEN, app: "xoxb-again" })).text).toContain("xapp-");
  });

  it("stores the tokens, then the workspace details, only after the check passes, and says Connected", async () => {
    const { url, rec, done } = await page(async () => SETTINGS);
    const reply = await post(url, GOOD);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Connected");
    expect(rec.stored.map(([id]) => id)).toEqual(["slack", "slack-settings"]);
    expect(JSON.parse(rec.stored[0]?.[1] ?? "{}")).toEqual(GOOD);
    expect(JSON.parse(rec.stored[1]?.[1] ?? "{}")).toEqual(SETTINGS);
    await expect(done).resolves.toBe("stored");
  });

  it("stores nothing and explains in plain words when Slack refuses, never repeating a token", async () => {
    const { url, rec } = await page(async () => {
      throw new ActionFailure("The Slack app was removed or its token changed: run 'taskfollow secret slack' again");
    });
    const reply = await post(url, { bot: "xoxb-secret-value", app: APP_TOKEN });
    expect(reply.status).toBe(400);
    expect(rec.stored).toEqual([]);
    expect(reply.text).not.toContain("xoxb-secret-value");
    expect(reply.text).not.toContain("run 'taskfollow secret slack'");
  });

  it("refuses a foreign Host, an unknown path and a post from another origin", async () => {
    const { url } = await page();
    expect((await request(url, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await request(`${new URL(url).origin}/s/${"0".repeat(64)}`)).status).toBe(404);
    expect((await request(url, { method: "POST", headers: formHeaders("http://evil.example"), body: "bot=x&app=y" })).status).toBe(403);
  });

  it("expires after its time limit", async () => {
    const { done } = await page(undefined, 50);
    await expect(done).resolves.toBe("expired");
  });
});

describe("the Slack setup page against the fake Slack (D135)", () => {
  it("proves the bot token, the app token and the live connection, then keeps the workspace details", async () => {
    const { url, rec } = await page();
    const reply = await post(url, GOOD);
    expect(reply.text).toContain("Connected");
    expect(JSON.parse(rec.stored[1]?.[1] ?? "{}")).toEqual({ team_id: SLACK_IDS.team_id, team: SLACK_IDS.team, bot_user_id: SLACK_IDS.bot_user_id, app_id: SLACK_IDS.app_id });
  });

  it("names the bot token when it is the one that is wrong", async () => {
    const { url, rec } = await page();
    const reply = await post(url, { bot: "xoxb-wrong", app: APP_TOKEN });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("Bot User OAuth Token");
    expect(rec.stored).toEqual([]);
  });

  it("names the app token when it is the one that is wrong", async () => {
    const { url, rec } = await page();
    const reply = await post(url, { bot: BOT_TOKEN, app: "xapp-wrong" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("App-Level Token");
    expect(rec.stored).toEqual([]);
  });
});
