import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { saveChannel, type EmailConfig } from "../../src/core/channels.js";
import { emailChannel } from "../../src/core/email-channel.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { parseMail } from "../../src/core/mime.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, startFakeSmtp, type FakeServer } from "../helpers/fake-mail.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";

const DAY = "2026-10-14T12:00:00.000Z";
const ASKED = "<q1@shop-customer.example>";
let fake: FakeTelegram;
const servers: FakeServer[] = [];
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function setup() {
  const home = await channelHome(false);
  await saveChannel(home, {
    channel: "email", address: "desk@example.com", verified_at: DAY,
    imap: { host: "imap.example.com", port: 993, security: "ssl", user: "desk@example.com" }, smtp: { host: "smtp.example.com", port: 465, security: "ssl", user: "desk@example.com" },
  });
  await storeInbound(home, normalizeInbound({ channel: "email", from: "sam@example.com", thread: ASKED, text: "Where is my order?", message_id: ASKED, subject: "Order #1001" }, DAY), "event");
  const ctx: ToolContext = await toolContext(home, "mcp", DEFAULT_TOOLS, () => DAY);
  return { home, ctx };
}

async function approved(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool: "channel.send", args, why: "Answer the customer" });
  await approveItem(ctx.home, item.id as number, { name: "terminal", role: "member" }, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

const REPLY = { channel: "email", to: "sam@example.com", text: "It shipped yesterday.", reply_to: ASKED };

describe("an email's subject is kept with the message (D143)", () => {
  it("keeps one line of the subject, and none when there is none", () => {
    const kept = normalizeInbound({ channel: "email", from: "s@example.com", thread: "t", text: "x", message_id: "m", subject: `Order\r\n#1001 ${"x".repeat(400)}` }, DAY);
    expect(kept.subject).toMatch(/^Order #1001 x+$/);
    expect(kept.subject?.length).toBeLessThanOrEqual(300);
    expect(normalizeInbound({ channel: "telegram", from: "1", thread: "1", text: "x", message_id: "m" }, DAY)).not.toHaveProperty("subject");
  });
});

describe("replying in the customer's email conversation (D143)", () => {
  it("sends the reply as part of the same conversation, with Re: and the original subject", async () => {
    const { ctx, home } = await setup();
    const token = await approved(ctx, REPLY);
    expect(await invokeTool(ctx, "channel.send", { ...REPLY, approval_token: token })).toMatchObject({ status: "recorded" });
    const recorded = JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8")) as Record<string, unknown>;
    expect(recorded).toMatchObject({ to: "sam@example.com", subject: "Re: Order #1001", in_reply_to: ASKED });
  });

  it("keeps a subject the workflow gave, and does not add a second Re:", async () => {
    const { ctx, home } = await setup();
    const token = await approved(ctx, { ...REPLY, subject: "Re: Your order" });
    await invokeTool(ctx, "channel.send", { ...REPLY, subject: "Re: Your order", approval_token: token });
    expect(JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8"))).toMatchObject({ subject: "Re: Your order", in_reply_to: ASKED });
  });

  it("refuses a reply to a message this person never sent, before any approval is asked", async () => {
    const { ctx, home } = await setup();
    await storeInbound(home, normalizeInbound({ channel: "email", from: "someone-else@example.com", thread: "<o@x>", text: "hello", message_id: "<o@x>" }, DAY), "event");
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { ...REPLY, to: "someone-else@example.com" }, why: "x" })).rejects.toThrow("reply_to");
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { ...REPLY, reply_to: "<never@x>" }, why: "x" })).rejects.toThrow("reply_to");
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { ...REPLY, reply_to: "not a message id" }, why: "x" })).rejects.toThrow("reply_to");
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { channel: "telegram", to: "5005", text: "x", reply_to: ASKED }, why: "x" })).rejects.toThrow("only email");
  });

  it("puts In-Reply-To and References on the mail it sends", async () => {
    const imap = await startFakeImap("ssl", []);
    const smtp = await startFakeSmtp("starttls");
    servers.push(imap, smtp);
    const config: EmailConfig = {
      channel: "email", address: MAIL_USER, verified_at: DAY,
      imap: { host: "127.0.0.1", port: imap.port, security: "ssl", user: MAIL_USER }, smtp: { host: "127.0.0.1", port: smtp.port, security: "starttls", user: MAIL_USER },
    };
    await emailChannel(config, MAIL_PASSWORD, TEST_TLS_ENV).send({ to: "sam@example.com", text: "It shipped.", subject: "Re: Order #1001", in_reply_to: ASKED });
    const data = smtp.received[0]?.data ?? "";
    expect(data).toContain(`In-Reply-To: ${ASKED}`);
    expect(data).toContain(`References: ${ASKED}`);
    expect(parseMail(Buffer.from(data, "latin1")).in_reply_to).toBe(ASKED);
  });
});
