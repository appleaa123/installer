import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheck } from "../../src/core/actions.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { channelCommand, parseEmailSetup } from "../../src/core/channel-commands.js";
import { loadChannel, loadCursor, openChannel } from "../../src/core/channels.js";
import { disconnect } from "../../src/core/disconnect.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, startFakeSmtp, type FakeImap, type FakeSmtp } from "../helpers/fake-mail.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { fixedClock } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

const MAIL = (from: string, text: string, id: string) => `From: ${from}\r\nSubject: s\r\nMessage-ID: <${id}@example.com>\r\n\r\n${text}\r\n`;
let telegram: FakeTelegram;
let servers: (FakeImap | FakeSmtp)[] = [];
beforeAll(async () => {
  telegram = await startFakeTelegram();
});
afterAll(() => telegram.stop());
afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop()));
  servers = [];
});

/** A home and a private file keychain holding the given secrets, plus the env that reaches the fakes. */
async function setup(secrets: Record<string, string>) {
  const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome(), ...telegram.env, ...TEST_TLS_ENV };
  for (const [id, value] of Object.entries(secrets)) await setSecret(id, value, env);
  return { home: await makeTempHome(), env, now: fixedClock("2026-10-08T12:00:00.000Z") };
}

async function mailServers(messages: readonly string[] = []) {
  const imap = await startFakeImap("ssl", messages);
  const smtp = await startFakeSmtp("starttls");
  servers.push(imap, smtp);
  const value = JSON.stringify({ address: MAIL_USER, imap: { host: "127.0.0.1", port: imap.port, security: "ssl" }, smtp: { host: "127.0.0.1", port: smtp.port, security: "starttls" } });
  return { imap, smtp, value };
}

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("the email setup (D75)", () => {
  it("takes the address as the sign-in name unless a user is given", () => {
    const setup = parseEmailSetup('{"address":"Desk@Example.com","imap":{"host":"imap.example.com","port":993,"security":"ssl","user":"desk"},"smtp":{"host":"smtp.example.com","port":587,"security":"starttls"}}');
    expect(setup).toEqual({
      channel: "email", address: "desk@example.com",
      imap: { host: "imap.example.com", port: 993, security: "ssl", user: "desk" }, smtp: { host: "smtp.example.com", port: 587, security: "starttls", user: "desk@example.com" },
    });
  });

  it.each([
    ["no value", undefined, "channel email needs --value"],
    ["no address", '{"imap":{},"smtp":{}}', "address must be an email address"],
    ["a bad port", '{"address":"a@b.co","imap":{"host":"h","port":0,"security":"ssl"},"smtp":{}}', "imap.port must be a port number"],
    ["an unknown security", '{"address":"a@b.co","imap":{"host":"h","port":993,"security":"tls"},"smtp":{}}', "imap.security must be one of ssl, starttls"],
    ["a host with a space", '{"address":"a@b.co","imap":{"host":"h","port":993,"security":"ssl"},"smtp":{"host":"a b","port":465,"security":"ssl"}}', "smtp.host must be a host name"],
  ])("refuses %s", (_what, value, message) => {
    expect(() => parseEmailSetup(value)).toThrow(message);
  });
});

describe("installer channel (D73)", () => {
  it("verifies the Telegram bot with getMe and saves it without the token", async () => {
    const { home, env, now } = await setup({ telegram: BOT_TOKEN });
    expect(await channelCommand(home, "telegram", undefined, now, env)).toMatchObject({ status: "verified", channel: "telegram", bot: "@desk_test_bot", capabilities: { inbound: "long_poll", buttons: false } });
    expect(await loadChannel(home, "telegram")).toMatchObject({ channel: "telegram", bot: { id: 999, username: "desk_test_bot" } });
    expect(await readFile(join(home, "config", "channels", "telegram.json"), "utf8")).not.toContain(BOT_TOKEN);
    expect(await events(home)).toEqual(["channel.verified"]);
  });

  it("says to store the token first, and saves nothing", async () => {
    const { home, env, now } = await setup({});
    await expect(channelCommand(home, "telegram", undefined, now, env)).rejects.toThrow(new ActionFailure("No telegram secret is stored: run 'installer secret telegram' and enter it on the page that opens"));
    expect(await loadChannel(home, "telegram")).toBeNull();
  });

  it("verifies the mailbox with an IMAP and an SMTP sign-in, sends nothing, and starts reading after the newest message", async () => {
    const { home, env, now } = await setup({ email: MAIL_PASSWORD });
    const { smtp, value } = await mailServers([MAIL("old@example.com", "old", "o1")]);
    expect(await channelCommand(home, "email", value, now, env)).toMatchObject({ status: "verified", channel: "email", address: MAIL_USER });
    expect(smtp.received).toEqual([]);
    expect(await loadCursor(home, "email")).toEqual({ uidvalidity: 7, last_uid: 101 });
    expect(await readFile(join(home, "config", "channels", "email.json"), "utf8")).not.toContain(MAIL_PASSWORD);
  });

  it("refuses a wrong app password and saves nothing", async () => {
    const { home, env, now } = await setup({ email: "wrong" });
    const { value } = await mailServers();
    await expect(channelCommand(home, "email", value, now, env)).rejects.toThrow("refused the sign-in");
    expect(await loadChannel(home, "email")).toBeNull();
  });

  it("lists the configured channels, refuses an unknown one and a value for Telegram", async () => {
    const { home, env, now } = await setup({ telegram: BOT_TOKEN });
    await channelCommand(home, "telegram", undefined, now, env);
    expect(await channelCommand(home, undefined, undefined, now, env)).toEqual({ channels: [expect.objectContaining({ channel: "telegram", risk: { official_api: true, outbound_external: true, sender_verified: true } })] });
    await expect(channelCommand(home, "sms", undefined, now, env)).rejects.toThrow(new InputError("Channels: telegram, email; for example: installer channel telegram"));
    await expect(channelCommand(home, "telegram", "{}", now, env)).rejects.toThrow("channel telegram takes no --value");
  });

  it("completes a CHANNELS step through the check channel_verified", async () => {
    const { home, env, now } = await setup({ telegram: BOT_TOKEN });
    const before = await runCheck(home, { check: "channel_verified", args: { channel: "telegram" } });
    expect(before).toEqual({ ok: false, hint: "The telegram channel is not set up yet: store its secret with 'installer secret telegram', run 'installer channel telegram', then run the verify again" });
    await channelCommand(home, "telegram", undefined, now, env);
    expect(await runCheck(home, { check: "channel_verified", args: { channel: "telegram" } })).toEqual({ ok: true });
  });
});

describe("the channel connectors (§12.2)", () => {
  it("Telegram: receives text messages with a cursor past them, and sends", async () => {
    const { home, env, now } = await setup({ telegram: BOT_TOKEN });
    await channelCommand(home, "telegram", undefined, now, env);
    const channel = await openChannel(home, "telegram", env);
    await telegram.message(2002, "hello bot");
    const first = await channel.receive(null, 0, new AbortController().signal);
    expect(first.messages.at(-1)).toMatchObject({ channel: "telegram", from: "2002", text: "hello bot" });
    expect((await channel.receive(first.cursor, 0, new AbortController().signal)).messages).toEqual([]);
    await channel.send({ to: "2002", text: "hi" });
    expect((await telegram.sent()).at(-1)).toEqual({ chat_id: "2002", text: "hi" });
  });

  it("email: reads only new mail from others, oldest first, and sends from the mailbox's address", async () => {
    const { home, env, now } = await setup({ email: MAIL_PASSWORD });
    const { imap, smtp, value } = await mailServers([MAIL("old@example.com", "old", "o1")]);
    await channelCommand(home, "email", value, now, env);
    const channel = await openChannel(home, "email", env);
    imap.deliver(MAIL("Ada <ada@example.com>", "A3", "a1"));
    imap.deliver(MAIL(MAIL_USER, "my own copy", "m1"));
    const read = await channel.receive(await loadCursor(home, "email"), 0, new AbortController().signal);
    expect(read).toEqual({ messages: [{ channel: "email", from: "ada@example.com", thread: "<a1@example.com>", text: "A3", message_id: "<a1@example.com>" }], cursor: { uidvalidity: 7, last_uid: 103 } });
    await channel.send({ to: "ada@example.com", text: "Thanks", subject: "Re: s" });
    expect(smtp.received[0]).toMatchObject({ from: MAIL_USER, to: "ada@example.com" });
  });

  it("email: a renumbered mailbox restarts after its newest message instead of reading it all again", async () => {
    const { home, env, now } = await setup({ email: MAIL_PASSWORD });
    const { value } = await mailServers([MAIL("old@example.com", "old", "o1")]);
    await channelCommand(home, "email", value, now, env);
    const channel = await openChannel(home, "email", env);
    expect(await channel.receive({ uidvalidity: 3, last_uid: 0 }, 0, new AbortController().signal)).toEqual({ messages: [], cursor: { uidvalidity: 7, last_uid: 101 } });
  });

  it("refuses to open a channel that is not set up", async () => {
    const { home, env } = await setup({});
    await expect(openChannel(home, "email", env)).rejects.toThrow("run 'installer channel email' first");
  });
});

describe("installer disconnect <channel> (§14.2)", () => {
  it("deletes the secret and the channel's settings, and says what else to do", async () => {
    const { home, env, now } = await setup({ telegram: BOT_TOKEN });
    await channelCommand(home, "telegram", undefined, now, env);
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", env.INSTALLER_KEYCHAIN_DIR);
    expect(await disconnect(home, "telegram", now)).toEqual({ status: "disconnected", connector: "telegram", secret_deleted: true, note: expect.stringContaining("send /revoke to @BotFather") });
    vi.unstubAllEnvs();
    expect(await getSecret("telegram", env)).toBeNull();
    expect(await loadChannel(home, "telegram")).toBeNull();
  });
});
