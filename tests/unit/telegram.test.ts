import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { telegramApi, telegramInbound } from "../../src/core/telegram.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";

let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
});
afterAll(() => fake.stop());

describe("the Telegram Bot API (D74)", () => {
  it("reads the bot with getMe", async () => {
    await expect(telegramApi(BOT_TOKEN, fake.env).getMe()).resolves.toEqual({ id: 999, username: "desk_test_bot" });
  });

  it("refuses a wrong token with what to do, and never prints the token", async () => {
    const refused = telegramApi("456:wrong-token", fake.env).getMe();
    await expect(refused).rejects.toThrow(ActionFailure);
    await expect(refused).rejects.toThrow("run 'installer secret telegram'");
    await expect(refused).rejects.not.toThrow("wrong-token");
  });

  it("long-polls getUpdates, and an offset confirms the updates before it", async () => {
    const api = telegramApi(BOT_TOKEN, fake.env);
    await fake.message(1001, "hello");
    await fake.message(1002, "A12");
    const first = await api.getUpdates(null, 0);
    expect(first.map((update) => update.update_id)).toEqual([1, 2]);
    const waiting = api.getUpdates(3, 5);
    await fake.message(1001, "later");
    expect((await waiting).map((update) => update.update_id)).toEqual([3]);
  });

  it("returns no updates when the gateway stops during a long poll", async () => {
    const stop = new AbortController();
    const polling = telegramApi(BOT_TOKEN, fake.env).getUpdates(100, 5, stop.signal);
    stop.abort();
    await expect(polling).resolves.toEqual([]);
  });

  it("sends a message and says when Telegram refuses one", async () => {
    const api = telegramApi(BOT_TOKEN, fake.env);
    await expect(api.sendMessage("1001", "Approval 3 waits for you")).resolves.toBeGreaterThan(0);
    expect((await fake.sent()).at(-1)).toEqual({ chat_id: "1001", text: "Approval 3 waits for you" });
    await expect(api.sendMessage("404", "x")).rejects.toThrow("Telegram refused sendMessage (400: Bad Request: chat not found)");
  });

  it("says when Telegram cannot be reached", async () => {
    await expect(telegramApi(BOT_TOKEN, { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:9", INSTALLER_KEYCHAIN: "file" }).getMe()).rejects.toThrow("Cannot reach Telegram");
  });
});

describe("a Telegram update as inbound", () => {
  const update = (message: Record<string, unknown>) => ({ update_id: 5, message: { message_id: 9, from: { id: 1001, is_bot: false }, chat: { id: 1001, type: "private" }, ...message } });

  it("keeps the sender, the chat, the text (or a caption) and the update id", () => {
    expect(telegramInbound(update({ text: "A12" }))).toEqual({ channel: "telegram", from: "1001", thread: "1001", text: "A12", message_id: "5" });
    expect(telegramInbound(update({ caption: "see photo" }))?.text).toBe("see photo");
  });

  it.each([
    ["a message from a bot", update({ text: "hi", from: { id: 7, is_bot: true } })],
    ["a sticker with no text", update({ sticker: {} })],
    ["an edited message", { update_id: 6, edited_message: { text: "x" } }],
  ])("skips %s", (_what, value) => {
    expect(telegramInbound(value)).toBeNull();
  });
});
