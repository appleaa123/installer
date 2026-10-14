import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { saveAttachments } from "../../src/core/attachments.js";
import { saveChannel } from "../../src/core/channels.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { OUTBOX_DIR } from "../../src/core/outbound.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";

const DAY = "2026-10-08T12:00:00.000Z";
let fake: FakeTelegram;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

/** An unfinished install (messages are only recorded) with an email channel, a saved file, and a contact who wrote first. */
async function setup() {
  const home = await channelHome(false);
  await saveChannel(home, {
    channel: "email", address: "desk@example.com", verified_at: DAY,
    imap: { host: "imap.example.com", port: 993, security: "ssl", user: "desk@example.com" }, smtp: { host: "smtp.example.com", port: 465, security: "ssl", user: "desk@example.com" },
  });
  await storeInbound(home, normalizeInbound({ channel: "email", from: "ada@example.com", thread: "<t1@x>", text: "Can you send the quote?", message_id: "<t1@x>" }, DAY), "event");
  const [ref] = await saveAttachments(home, { channel: "email", message_id: "<old@x>" }, [{ name: "quote.pdf", type: "application/pdf", bytes: Buffer.from("%PDF-1 original") }]);
  const ctx: ToolContext = await toolContext(home, "mcp", DEFAULT_TOOLS, () => DAY);
  return { home, ctx, ref: ref as string };
}

async function approved(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const item = await invokeTool(ctx, "approvals.request", { tool: "channel.send", args, why: "Ada asked for the quote." });
  await approveItem(ctx.home, item.id as number, { name: "terminal", role: "member" }, ctx.now());
  return (await invokeTool(ctx, "approvals.get", { id: item.id })).approval_token as string;
}

const SEND = (ref: string) => ({ channel: "email", to: "ada@example.com", text: "Here is the quote.", subject: "Quote", attachments: [ref] });

describe("channel.send with files (D133)", () => {
  it("records the file names and sizes while the install is not finished, never the bytes", async () => {
    const { ctx, home, ref } = await setup();
    const token = await approved(ctx, SEND(ref));
    const result = await invokeTool(ctx, "channel.send", { ...SEND(ref), approval_token: token });
    expect(result).toMatchObject({ status: "recorded" });
    const recorded = JSON.parse(await readFile(join(home, OUTBOX_DIR, "1.json"), "utf8")) as { attachments: { filename: string; size: number }[] };
    expect(recorded.attachments).toEqual([expect.objectContaining({ filename: "quote.pdf", size: 15 })]);
    expect(JSON.stringify(recorded)).not.toContain("PDF-1");
  });

  it("binds the approval to the file's content: a changed file cannot go out under the old approval", async () => {
    const { ctx, home, ref } = await setup();
    const token = await approved(ctx, SEND(ref));
    await writeFile(join(home, ...ref.split("/")), "%PDF-1 swapped for something else");
    await expect(invokeTool(ctx, "channel.send", { ...SEND(ref), approval_token: token })).rejects.toThrow(/approval/i);
  });

  it("refuses a file that is not a saved attachment of a message", async () => {
    const { ctx } = await setup();
    for (const ref of ["audit/audit.jsonl", "../../etc/passwd", "data/inbox-files/../../audit/audit.jsonl", "data/inbox-files/0000000000000000/missing.pdf", "data/inbox-files/ZZZ/quote.pdf"]) {
      await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: SEND(ref), why: "x" })).rejects.toThrow();
    }
  });

  it("allows files only on email", async () => {
    const { ctx, ref } = await setup();
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { channel: "telegram", to: "5555", text: "hi", attachments: [ref] }, why: "x" })).rejects.toThrow("only email");
  });

  it("allows at most five files", async () => {
    const { ctx, ref } = await setup();
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { ...SEND(ref), attachments: Array(6).fill(ref) }, why: "x" })).rejects.toThrow("at most 5");
  });
});
