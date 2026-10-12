import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listApprovals } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { saveChannel } from "../../src/core/channels.js";
import { scanInjection } from "../../src/core/envelope.js";
import { handleInbound } from "../../src/core/inbound.js";
import { listInbox } from "../../src/core/inbox.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { listOutbox } from "../../src/core/outbound.js";
import { isPaused } from "../../src/core/pause.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext, type ToolContext } from "../../src/core/tools.js";
import { ADA, ROLES, channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { CORPUS } from "../helpers/injection-corpus.js";

const NOW = "2026-10-09T12:00:00.000Z";
const ACCOUNT = { host: "127.0.0.1", port: 993, security: "ssl" as const, user: "desk@example.com" };
let fake: FakeTelegram;
let ids = 0;
beforeAll(async () => {
  fake = await startFakeTelegram();
  await useFakeTelegram(fake);
});
afterAll(() => fake.stop());

const telegram = (from: string, text: string) => ({ channel: "telegram", from, thread: from, text, message_id: `t${++ids}` });
const email = (from: string, text: string) => ({ channel: "email", from, thread: `<${++ids}@example.com>`, text, message_id: `<${ids}@example.com>` });
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

/** Every file under the home, as one text: the secret must be in none of them. */
async function everything(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(entries.map((entry) => (entry.isDirectory() ? everything(join(dir, entry.name)) : readFile(join(dir, entry.name), "utf8"))));
  return parts.join("\n");
}

/**
 * A finished install (real sends to the fake Telegram) with an email channel too; Ada joined on both, Owner is the
 * decision maker; one memo and two approvals waiting (L2 memo.edit, L3 memo.delete).
 */
async function gateway(): Promise<ToolContext> {
  const ctx = await toolContext(await channelHome(true, NOW), "gateway", DEFAULT_TOOLS, () => NOW);
  await saveChannel(ctx.home, { channel: "email", address: "desk@example.com", imap: ACCOUNT, smtp: ACCOUNT, verified_at: NOW });
  const { code } = await createInvite(ctx.home, "Ada", ROLES, NOW);
  await joinWithCode(ctx.home, code, { channel: "email", address: "ada@example.com" }, NOW);
  await invokeTool(ctx, "memo.add", { text: "Draft" });
  await invokeTool(ctx, "approvals.request", { tool: "memo.edit", args: { id: 1, text: "Final" }, why: "Ready." });
  await invokeTool(ctx, "approvals.request", { tool: "memo.delete", args: { id: 1 }, why: "Not needed." });
  return ctx;
}

describe("the universal injection suite: inbound channels (§15.4, D117)", () => {
  it.each(CORPUS)("flags '$name' with exactly its patterns", ({ text, flags }) => {
    expect(scanInjection(text)).toEqual(flags);
  });

  it.each(CORPUS)("'$name' from a stranger or a member, by Telegram or email, is kept as flagged data and changes nothing", async ({ text, flags }) => {
    const ctx = await gateway();
    const sent = (await fake.sent()).length;
    const before = (await events(ctx.home)).length;
    const outcomes = [
      await handleInbound(ctx, telegram("5005", text)), await handleInbound(ctx, telegram(ADA.address, text)),
      await handleInbound(ctx, email("ada@example.com", text)), await handleInbound(ctx, email("someone@example.net", text)),
    ];
    expect(outcomes).toEqual(["event", "conversation", "conversation", "event"]);
    expect((await listInbox(ctx.home)).map((item) => item.injection)).toEqual([flags, flags, flags, flags]);
    expect((await listApprovals(ctx.home, NOW)).map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(((await invokeTool(ctx, "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text)).toEqual(["Draft"]);
    expect(await isPaused(ctx.home)).toBe(false);
    expect(await fake.sent()).toHaveLength(sent);
    expect(await listOutbox(ctx.home)).toEqual([]);
    expect((await events(ctx.home)).slice(before)).toEqual(["channel.received", "channel.received", "channel.received", "channel.received"]);
    expect(await everything(ctx.home)).not.toContain(BOT_TOKEN);
  });

  it.each([
    ["a reply code", "A1"],
    ["the kill switch", "/pause"],
  ])("%s from someone who never joined decides nothing", async (_name, text) => {
    const ctx = await gateway();
    expect(await handleInbound(ctx, telegram("5005", text))).toBe("event");
    expect((await listApprovals(ctx.home, NOW)).map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(await isPaused(ctx.home)).toBe(false);
  });
});
