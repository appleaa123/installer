/**
 * Opt-in live test of the Telegram connector (D48, D74): `npm run test:live` with
 *   TELEGRAM_BOT_TOKEN (a bot the developer made with @BotFather) and
 *   TELEGRAM_TEST_CHAT_ID (the developer's own chat with that bot)
 * in the environment; everything is skipped when either is empty. It calls only https://api.telegram.org:
 * getMe, and sendMessage ONCE, which puts one real message into the developer's own test chat. It never
 * calls getUpdates, so it confirms nothing a running gateway has not read yet.
 */
import { describe, expect, it } from "vitest";
import { telegramApi } from "../../src/core/telegram.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID ?? "";
/** No loopback override, whatever the shell has set: the live test talks to Telegram itself. */
const NO_OVERRIDE = {};

describe.skipIf(!TOKEN || !CHAT_ID)("real Telegram bot (D74)", () => {
  it("reads the bot with getMe", async () => {
    const bot = await telegramApi(TOKEN, NO_OVERRIDE).getMe();
    expect(bot.username).toMatch(/bot$/i);
  });

  it("sends one message to the test chat", async () => {
    const sent = await telegramApi(TOKEN, NO_OVERRIDE).sendMessage(CHAT_ID, `installer live test ${new Date().toISOString()} (Plan 6). You can delete it.`);
    expect(sent).toBeGreaterThan(0);
  });
});
