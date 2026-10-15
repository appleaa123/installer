import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDelivery, verifySignature, whatsappApi, recipientField, pullRelay } from "../../src/core/whatsapp.js";
import { WA, startFakeWhatsApp, textPayload, type FakeWhatsApp } from "../helpers/fake-whatsapp.js";

let fake: FakeWhatsApp;
beforeAll(async () => {
  fake = await startFakeWhatsApp();
});
afterAll(() => fake.stop());

const SECRETS = { access_token: WA.token, app_secret: WA.secret, pull_token: WA.pull };
const sign = (bytes: Buffer, secret: string = WA.secret) => `sha256=${createHmac("sha256", secret).update(bytes).digest("hex")}`;

describe("Meta's signature on each delivery (D149)", () => {
  const body = Buffer.from(JSON.stringify(textPayload()), "utf8");
  it("accepts the exact bytes Meta signed, and nothing else", () => {
    expect(verifySignature(body, sign(body), WA.secret)).toBe(true);
    expect(verifySignature(Buffer.concat([body, Buffer.from(" ")]), sign(body), WA.secret)).toBe(false);
    expect(verifySignature(body, sign(body, "other"), WA.secret)).toBe(false);
    expect(verifySignature(body, "", WA.secret)).toBe(false);
    expect(verifySignature(body, sign(body).replace("sha256=", ""), WA.secret)).toBe(false);
  });
});

describe("reading a delivery (D149)", () => {
  it("keeps a customer's text with Meta's time, the message id and the sender's number", () => {
    const [message] = parseDelivery(textPayload({ timestamp: 1_760_436_000 }), WA.phone_id);
    expect(message).toEqual({ channel: "whatsapp", from: "15550001111", thread: "15550001111", text: "Where is my order #1001?", message_id: "wamid.in1", sent_at: "2025-10-14T10:00:00.000Z" });
  });

  it("uses the username id when Meta sends one, with or without a number", () => {
    expect(parseDelivery(textPayload({ from_user_id: "US.1234567890" }), WA.phone_id)[0]?.from).toBe("US.1234567890");
    expect(parseDelivery(textPayload({ from: undefined, from_user_id: "US.1234567890" }), WA.phone_id)[0]?.from).toBe("US.1234567890");
  });

  it("turns a photo or other media into a note, and ignores delivery receipts", () => {
    expect(parseDelivery(textPayload({ type: "image" }), WA.phone_id)[0]?.text).toBe("(sent an image: open WhatsApp to see it)");
    const receipt = { object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: WA.phone_id }, statuses: [{ id: "wamid.out1", status: "read" }] } }] }] };
    expect(parseDelivery(receipt, WA.phone_id)).toEqual([]);
  });

  it("drops messages for another business number", () => {
    expect(parseDelivery(textPayload({ phone_id: "999" }), WA.phone_id)).toEqual([]);
  });
});

describe("sending and checking with Meta (D149)", () => {
  it("chooses the recipient field from the address", () => {
    expect(recipientField("15550001111")).toEqual({ to: "15550001111" });
    expect(recipientField("US.1234567890")).toEqual({ recipient: "US.1234567890" });
  });

  it("checks the number, sends plain text without link previews, and cuts it at 4,096 characters", async () => {
    const api = whatsappApi(SECRETS, WA.phone_id, fake.env);
    expect(await api.phoneInfo()).toEqual({ display_number: "+1 555 0100", name: "Fake Shop" });
    await api.send("15550001111", "x".repeat(5000));
    const [message] = (await fake.sent()).slice(-1);
    expect(message).toMatchObject({ messaging_product: "whatsapp", to: "15550001111", type: "text", text: { preview_url: false } });
    expect(((message?.text as { body: string }).body).length).toBe(4096);
  });

  it("explains a closed window and a bad token in plain words, never repeating the token", async () => {
    await expect(whatsappApi(SECRETS, WA.phone_id, fake.env).send("CLOSED", "hi")).rejects.toThrow(/24 hours/);
    const bad = whatsappApi({ ...SECRETS, access_token: "EAAsecret-value" }, WA.phone_id, fake.env);
    const error = await bad.phoneInfo().then(() => null, (failure: Error) => failure.message);
    expect(error).toMatch(/taskfollow secret whatsapp/);
    expect(error).not.toContain("EAAsecret-value");
  });
});

describe("pulling from the relay (D149)", () => {
  it("gets what Meta delivered with the pull token, and nothing without it", async () => {
    await fake.deliver(textPayload({ id: "wamid.pull1" }));
    const items = await pullRelay(fake.url, WA.pull, 0, fake.env);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(items.at(-1)?.body_b64 ?? "", "base64").toString()).toContain("wamid.pull1");
    await expect(pullRelay(fake.url, "wrong", 0, fake.env)).rejects.toThrow(/pull token/);
  });

  it("refuses a relay address that is not a workers.dev address outside tests", async () => {
    await expect(pullRelay("https://evil.example.com", WA.pull, 0, {})).rejects.toThrow(/workers\.dev/);
  });
});
