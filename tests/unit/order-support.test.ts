import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REASON_TOOL } from "../../src/core/agent-hook.js";
import { approveItem, listApprovals } from "../../src/core/approvals.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { resumeRun, startRun, type RunRequest } from "../../src/core/runner.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { whyCommand, type WhyEntry } from "../../src/core/why.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { channelHome, useFakeTelegram } from "../helpers/channel-home.js";
import { startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { FAKE_RUNTIME } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/**
 * The online-store support case end to end (D139): a customer asks where their order is; the person's agent looks it
 * up read-only with the store's command-line tool (a fake `shopify` here); a judge drafts the answer; a person
 * approves the exact reply; it is sent; `taskfollow why` explains each step.
 */
const AT = "2026-10-14T12:00:00.000Z";
const LATER = "2026-10-14T12:10:00.000Z";
const ORDER = '{"data":{"orders":{"nodes":[{"name":"#1001","displayFulfillmentStatus":"FULFILLED","trackingUrl":"https://track.example/1001"}]}}}';
const LOOKUP_COMMAND = "shopify store execute -s demo.myshopify.com -q '{orders(first:1,query:\"name:1001\"){nodes{name displayFulfillmentStatus}}}' --no-input";
const ORDER_SUPPORT = {
  workflow: "order-support", version: 1, description: "Answers customers who ask about their order", trigger: { event: "message.received", from: "external" },
  steps: [
    {
      id: "lookup",
      task: {
        prompt: "A customer wrote the message below. If it is about an order, find that order with the Shopify CLI and say its status.",
        input: { message: "${event.text}" },
        may_use: ["Bash(shopify store execute:*)"],
        output: { type: "object", properties: { order_found: { type: "boolean" }, order: { type: "string" }, status: { type: "string" } }, required: ["order_found"] },
      },
    },
    {
      id: "draft",
      judge: {
        instructions: "Write a short, friendly reply to the customer using the order facts.",
        input: { message: "${event.text}", order: "${lookup}" },
        schema: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false },
      },
    },
    { id: "send", approve: { tool: "channel.send", args: { channel: "telegram", to: "${event.from}", text: "${draft.reply}" }, why: "Answer the customer's question about their order" } },
  ],
};

let telegram: FakeTelegram;
let bin = "";
beforeAll(async () => {
  telegram = await startFakeTelegram();
  await useFakeTelegram(telegram);
  bin = join(await makeTempHome(), "bin");
  await mkdir(bin);
  await writeFile(join(bin, "shopify"), `#!/bin/sh\necho '${ORDER}'\n`);
  await chmod(join(bin, "shopify"), 0o755);
});
afterAll(() => telegram.stop());
beforeEach(async () => {
  vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome());
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
});
afterEach(() => vi.unstubAllEnvs());

describe("a customer asks about their order (D139)", () => {
  it("looks the order up read-only, drafts a reply, waits for a person, sends it, and explains every step", async () => {
    const home = await channelHome(true, AT);
    const state = await loadState(home);
    if (!state) throw new Error("no state");
    await saveState(home, { ...state, runtime: FAKE_RUNTIME });
    const message = await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text: "Hi, where is my order #1001?", message_id: "m1" }, AT), "event");
    vi.stubEnv("FAKE_AGENT_TASK", JSON.stringify({
      calls: [
        { tool: REASON_TOOL, input: { tool: "Bash", why: "the customer asks where order #1001 is" } },
        { tool: "Bash", input: { command: LOOKUP_COMMAND } },
        { tool: "Bash", input: { command: `${LOOKUP_COMMAND.replace("--no-input", "--allow-mutations")}` } },
      ],
      answer: { order_found: true, order: "#1001", status: "FULFILLED" },
    }));
    vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify([{ reply: "Your order #1001 has shipped." }]));
    const request: RunRequest = { home, workflow: parseWorkflow(ORDER_SUPPORT, "order-support", DEFAULT_TOOLS), key: `order-support:inbox:${message.id}`, trigger: { kind: "event", inbox_id: message.id }, now: () => AT };

    const waiting = await startRun(request);
    expect(waiting).toMatchObject({ status: "waiting" });
    expect((await telegram.sent()).some((sent) => sent.chat_id === "5005")).toBe(false);
    const [item] = await listApprovals(home, AT);
    expect(item?.action).toEqual({ tool: "channel.send", args: { channel: "telegram", to: "5005", text: "Your order #1001 has shipped." } });

    await approveItem(home, item?.id ?? 0, { name: "Owner", role: "decision_maker" }, LATER);
    const done = await resumeRun({ ...request, now: () => LATER }, waiting);
    expect(done).toMatchObject({ status: "completed" });
    expect(await telegram.sent()).toContainEqual(expect.objectContaining({ chat_id: "5005", text: expect.stringContaining("Your order #1001 has shipped.") }));

    const why = (await whyCommand(home, done.run_id, () => LATER)) as { timeline: WhyEntry[] };
    const lines = why.timeline.map((entry) => `${entry.who} | ${entry.what} | ${entry.why}`);
    expect(lines).toContainEqual(expect.stringMatching(/^your agent \| Bash .*shopify store execute.*\| the customer asks where order #1001 is$/));
    expect(lines).toContainEqual(expect.stringMatching(/^TaskFollow \| refused Bash .*--allow-mutations.*\| This step may only read/));
    expect(lines).toContainEqual(expect.stringMatching(/^TaskFollow \| asked a person to approve channel\.send .*\| Answer the customer's question about their order$/));
    expect(lines).toContainEqual(expect.stringMatching(/^Owner \| approved channel\.send/));
  });
});
