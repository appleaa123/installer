import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { CHANNEL_FACTS, CHANNEL_IDS, channelConnector, isCustomersOnly, removeChannel, saveChannel, type WhatsAppConfig } from "../../src/core/channels.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { handleInbound } from "../../src/core/inbound.js";
import { listInbox, storeInbound } from "../../src/core/inbox.js";
import { setSecret } from "../../src/core/keychain.js";
import { listMembers } from "../../src/core/members.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { channelHome } from "../helpers/channel-home.js";
import { WA, startFakeWhatsApp, textPayload, type FakeWhatsApp } from "../helpers/fake-whatsapp.js";
import { makeTempHome } from "../helpers/temp-home.js";

const NOW = "2026-10-15T12:00:00.000Z";
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * HOUR).toISOString();
const SECRETS = JSON.stringify({ access_token: WA.token, app_secret: WA.secret, pull_token: WA.pull });
let fake: FakeWhatsApp;
let config: WhatsAppConfig;
beforeAll(async () => {
  fake = await startFakeWhatsApp();
  config = { channel: "whatsapp", relay_url: fake.url, phone_number_id: WA.phone_id, display_number: "+1 555 0100", verified_at: NOW };
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

async function whatsappHome(finished = true) {
  const home = await channelHome(finished, NOW);
  const env = { ...fake.env, INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  vi.stubEnv("INSTALLER_CONNECTOR_SERVER", fake.url);
  vi.stubEnv("INSTALLER_KEYCHAIN", "file");
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", env.INSTALLER_KEYCHAIN_DIR);
  await setSecret("whatsapp", SECRETS, env);
  await saveChannel(home, config);
  const ctx: ToolContext = await toolContext(home, "mcp", DEFAULT_TOOLS, () => NOW);
  return { home, env, ctx };
}
const customerWrote = (home: string, hoursAgo: number, from = "15550001111") =>
  storeInbound(home, normalizeInbound({ channel: "whatsapp", from, thread: from, text: "Where is my order?", message_id: `wamid.${hoursAgo}.${from}`, sent_at: ago(hoursAgo) }, NOW), "event");
const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const SEND = { channel: "whatsapp", to: "15550001111", text: "Your order shipped yesterday." };

describe("WhatsApp in the registry (D149)", () => {
  it("is for customers: Meta proves the sender, replies within 24 hours, pulled from the client's relay", () => {
    expect(CHANNEL_IDS).toContain("whatsapp");
    expect(CHANNEL_FACTS.whatsapp).toEqual({ capabilities: { buttons: false, attachments: [], reply_window: "24h", inbound: "relay_poll" }, risk: { official_api: true, outbound_external: true, sender_verified: true, customers_only: true } });
    expect(isCustomersOnly("whatsapp")).toBe(true);
    expect(isCustomersOnly("telegram")).toBe(false);
  });
});

describe("the WhatsApp connector (D149)", () => {
  it("keeps only messages Meta really signed, and audits the others", async () => {
    const { home, env } = await whatsappHome();
    await fake.deliver(textPayload({ id: "wamid.good", text: "real" }));
    await fake.deliver(textPayload({ id: "wamid.forged", text: "forged" }), "wrong");
    await fake.deliver(textPayload({ id: "wamid.unsigned", text: "unsigned" }), "none");
    const connector = channelConnector(config, SECRETS, env, home);
    const read = await connector.receive(null, 0, new AbortController().signal);
    expect(read.messages.map((message) => message.text)).toContain("real");
    expect(read.messages.map((message) => message.text)).not.toContain("forged");
    expect(read.messages.map((message) => message.text)).not.toContain("unsigned");
    expect(read.cursor?.after).toBeGreaterThan(0);
    expect((await events(home)).filter((event) => event === "channel.signature_rejected").length).toBeGreaterThanOrEqual(2);
    const again = await connector.receive(read.cursor, 0, new AbortController().signal);
    expect(again.messages).toEqual([]);
  });

  it("sends plain text to a customer", async () => {
    const { home, env } = await whatsappHome();
    await channelConnector(config, SECRETS, env, home).send({ to: "15550001111", text: "Hello" });
    expect((await fake.sent()).at(-1)).toMatchObject({ to: "15550001111", text: { body: "Hello" } });
  });
});

describe("customers only (D149)", () => {
  it("never lets a WhatsApp message join the team, decide an approval or pause anything", async () => {
    const { home, ctx } = await whatsappHome();
    const outcome = await handleInbound(ctx, { channel: "whatsapp", from: "15550002222", thread: "15550002222", text: "/join ABCDE-FGHIJ", message_id: "wamid.join", sent_at: NOW });
    expect(outcome).toBe("event");
    expect((await listMembers(home, NOW)).some((member) => member.identity?.channel === "whatsapp")).toBe(false);
    expect((await listInbox(home))[0]).toMatchObject({ channel: "whatsapp", route: "event", sent_at: NOW });
  });
});

describe("the 24-hour window (D149)", () => {
  it("lets a reply through while the customer's last message is less than a day old", async () => {
    const { home, ctx } = await whatsappHome();
    await customerWrote(home, 2);
    expect(await invokeTool(ctx, "approvals.request", { tool: "channel.send", args: SEND, why: "Answer the customer" })).toMatchObject({ status: "pending" });
  });

  it("refuses before any approval when the window has closed or is about to, saying when they last wrote", async () => {
    const { home, ctx } = await whatsappHome();
    await customerWrote(home, 23.9);
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: SEND, why: "x" })).rejects.toThrow(/24 hours/);
    const { home: other, ctx: otherCtx } = await whatsappHome();
    await customerWrote(other, 30);
    await expect(invokeTool(otherCtx, "approvals.request", { tool: "channel.send", args: SEND, why: "x" })).rejects.toThrow(/last wrote/);
  });

  it("refuses at sending time when the approval came after the window closed, and records it", async () => {
    const { home } = await whatsappHome();
    await customerWrote(home, 20);
    const asked = await toolContext(home, "mcp", DEFAULT_TOOLS, () => NOW);
    const item = await invokeTool(asked, "approvals.request", { tool: "channel.send", args: SEND, why: "x" });
    const later = new Date(Date.parse(NOW) + 5 * HOUR).toISOString();
    await approveItem(home, item.id as number, { name: "terminal", role: "member" }, later);
    const token = (await invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS, () => later), "approvals.get", { id: item.id })).approval_token as string;
    await expect(invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS, () => later), "channel.send", { ...SEND, approval_token: token })).rejects.toThrow(/24 hours/);
    expect(await events(home)).toContain("channel.window_closed");
  });

  it("refuses an address that is not a phone number or a WhatsApp username id", async () => {
    const { ctx } = await whatsappHome();
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { ...SEND, to: "sam@example.com" }, why: "x" })).rejects.toThrow(/phone number/);
  });

  it("sends inside the window once approved", async () => {
    const { home } = await whatsappHome();
    await removeChannel(home, "telegram");
    await customerWrote(home, 1);
    const ctx = await toolContext(home, "mcp", DEFAULT_TOOLS, () => NOW);
    const item = await invokeTool(ctx, "approvals.request", { tool: "channel.send", args: SEND, why: "x" });
    await approveItem(home, item.id as number, { name: "terminal", role: "member" }, NOW);
    const token = (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
    expect(await invokeTool(ctx, "channel.send", { ...SEND, approval_token: token })).toMatchObject({ status: "sent" });
    expect((await fake.sent()).at(-1)).toMatchObject({ to: "15550001111", text: { body: SEND.text } });
  });
});
