import { afterAll, beforeAll, describe } from "vitest";
import { channelConnector } from "../../src/core/channels.js";
import { loadConnector } from "../../src/core/connectors.js";
import { parseMail } from "../../src/core/mime.js";
import { clientOwnedTokens, parseSignIn } from "../../src/core/google-auth.js";
import { sheetsClient, type SheetsClient } from "../../src/core/sheets.js";
import { channelContract, sheetsContract } from "../helpers/contracts.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, startFakeSmtp, type FakeImap, type FakeSmtp } from "../helpers/fake-mail.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";

const AT = "2026-10-09T12:00:00.000Z";
const MAIL = (from: string, text: string, id: string) => `From: ${from}\r\nSubject: s\r\nMessage-ID: <${id}@example.com>\r\n\r\n${text}\r\n`;

describe("the Sheets adapter's contract against the fake Google (§15.3, D118)", () => {
  let google: FakeGoogle;
  let client: SheetsClient;
  beforeAll(async () => {
    google = await startFakeGoogle();
    const def = await loadConnector("google-sheets", "1");
    client = sheetsClient(def, clientOwnedTokens(def.auth, parseSignIn(SIGNED_IN), google.env), google.env);
    await google.debug("/debug/sheets/contract", { title: "contract", tabs: { Contract: [] } });
  });
  afterAll(() => google.stop());
  sheetsContract(() => ({ client, location: { spreadsheet_id: "contract", tab: "Contract" } }));
});

describe("the Telegram channel's contract against the fake Telegram (§15.3, D118)", () => {
  let telegram: FakeTelegram;
  beforeAll(async () => {
    telegram = await startFakeTelegram();
  });
  afterAll(() => telegram.stop());
  channelContract(() => ({
    channel: channelConnector({ channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: AT }, BOT_TOKEN, telegram.env),
    to: "2002",
    delivered: async () => (await telegram.sent()).filter((message) => message.chat_id === "2002").map((message) => message.text),
    inject: (text) => telegram.message(2002, text),
  }), { receive: true });
});

describe("the email channel's contract against the fake mail servers (§15.3, D118)", () => {
  let imap: FakeImap;
  let smtp: FakeSmtp;
  let ids = 0;
  beforeAll(async () => {
    imap = await startFakeImap("ssl", [MAIL("old@example.com", "old", "o1")]);
    smtp = await startFakeSmtp("starttls");
  });
  afterAll(async () => {
    await imap.stop();
    await smtp.stop();
  });
  channelContract(() => ({
    channel: channelConnector({
      channel: "email", address: MAIL_USER, verified_at: AT,
      imap: { host: "127.0.0.1", port: imap.port, security: "ssl", user: MAIL_USER }, smtp: { host: "127.0.0.1", port: smtp.port, security: "starttls", user: MAIL_USER },
    }, MAIL_PASSWORD, TEST_TLS_ENV),
    to: "ada@example.com",
    delivered: async () => smtp.received.filter((mail) => mail.to === "ada@example.com").map((mail) => parseMail(Buffer.from(mail.data)).text),
    inject: async (text) => imap.deliver(MAIL("ada@example.com", text, `c${++ids}`)),
  }), { receive: true });
});
