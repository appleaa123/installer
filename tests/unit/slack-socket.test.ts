import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { slackApi } from "../../src/core/slack.js";
import { SlackSocket, socketUrlAllowed, waitForHello } from "../../src/core/slack-socket.js";
import { APP_TOKEN, BOT_TOKEN, startFakeSlack, type FakeSlack } from "../helpers/fake-slack.js";

let fake: FakeSlack;
const open: SlackSocket[] = [];
beforeAll(async () => {
  fake = await startFakeSlack();
});
afterAll(() => fake.stop());
afterEach(async () => {
  await Promise.all(open.splice(0).map((socket) => socket.close()));
});

const SIGNAL = new AbortController().signal;
async function socket(extra: Partial<ConstructorParameters<typeof SlackSocket>[0]> = {}) {
  const spoolDir = await mkdtemp(join(tmpdir(), "slack-spool-"));
  const made = new SlackSocket({ api: slackApi({ bot: BOT_TOKEN, app: APP_TOKEN }, fake.env), spoolDir, env: fake.env, backoff: { initialMs: 20, maxMs: 200 }, ...extra });
  open.push(made);
  return { socket: made, spoolDir };
}
const until = async (check: () => Promise<boolean>, what: string, ms = 5000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

describe("which addresses the live connection may use (D135)", () => {
  it("allows wss on slack.com", () => {
    expect(socketUrlAllowed("wss://wss-primary.slack.com/link/?ticket=abc", {})).toBe(true);
  });

  it.each(["ws://wss-primary.slack.com/link", "wss://evil.example.com/link", "wss://slack.com.evil.example/link", "https://wss.slack.com/link", "wss://127.0.0.1:9/link", "not a url"])("refuses %s", (url) => {
    expect(socketUrlAllowed(url, {})).toBe(false);
  });

  it("allows a loopback address only for tests with the throwaway keychain", () => {
    expect(socketUrlAllowed("ws://127.0.0.1:5555/link", { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:5555", INSTALLER_KEYCHAIN: "file" })).toBe(true);
    expect(socketUrlAllowed("ws://127.0.0.1:5555/link", { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:5555" })).toBe(false);
    expect(socketUrlAllowed("ws://127.0.0.1:5555/link", {})).toBe(false);
  });
});

describe("receiving over the live connection (D135)", () => {
  it("saves an event first and only then acknowledges it", async () => {
    const { socket: live, spoolDir } = await socket();
    const first = live.receive(0, 3, SIGNAL);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    const sent = await fake.event({ user: "U0ADA", text: "hello" });
    const events = await first;
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ event: { text: "hello", user: "U0ADA" } });
    expect(await fake.acks()).toContain(sent.envelope_id);
    expect(await readdir(spoolDir)).toHaveLength(1);
  });

  it("returns nothing after the wait when nobody writes", async () => {
    const { socket: live } = await socket();
    const started = Date.now();
    expect(await live.receive(0, 1, SIGNAL)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("stops waiting when told to", async () => {
    const { socket: live } = await socket();
    const controller = new AbortController();
    const waiting = live.receive(0, 30, controller.signal);
    setTimeout(() => controller.abort(), 100);
    expect(await waiting).toEqual([]);
  });

  it("deletes what the last round already handled", async () => {
    const { socket: live, spoolDir } = await socket();
    const first = live.receive(0, 3, SIGNAL);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    await fake.event({ text: "one" });
    const [item] = await first;
    await fake.event({ text: "two" });
    const next = await live.receive(item?.seq ?? 0, 3, SIGNAL);
    expect(next.map((entry) => (entry.payload as { event: { text: string } }).event.text)).toEqual(["two"]);
    expect(await readdir(spoolDir)).toHaveLength(1);
  });

  it("keeps one copy of an event Slack sends again, and still acknowledges it", async () => {
    const { socket: live, spoolDir } = await socket();
    const first = live.receive(0, 3, SIGNAL);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    const sent = await fake.event({ text: "again" });
    await first;
    const before = (await fake.acks()).filter((id) => id === sent.envelope_id).length;
    await fake.redeliver();
    await until(async () => (await fake.acks()).filter((id) => id === sent.envelope_id).length === before + 1, "the second acknowledgement");
    expect(await readdir(spoolDir)).toHaveLength(1);
  });

  it("does not acknowledge when too much is waiting, so Slack sends it later", async () => {
    const { socket: live } = await socket({ maxSpool: 2 });
    const first = live.receive(0, 3, SIGNAL);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    const acksBefore = (await fake.acks()).length;
    for (const text of ["a", "b", "c"]) await fake.event({ text });
    await first;
    await until(async () => (await fake.acks()).length >= acksBefore + 2, "two acknowledgements");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await fake.acks()).length).toBe(acksBefore + 2);
  });

  it("finds what an earlier run saved but did not finish (a crash before the cursor)", async () => {
    const first = await socket();
    // A long wait: receive returns as soon as the event is saved, and a busy machine must not end it first.
    const waiting = first.socket.receive(0, 30, SIGNAL);
    await until(async () => (await fake.stats()).live >= 1, "the connection");
    await fake.event({ text: "unfinished" });
    expect((await waiting).length).toBe(1);
    await first.socket.close();
    const second = new SlackSocket({ api: slackApi({ bot: BOT_TOKEN, app: APP_TOKEN }, fake.env), spoolDir: first.spoolDir, env: fake.env, backoff: { initialMs: 20, maxMs: 200 } });
    open.push(second);
    const found = await second.receive(0, 0, SIGNAL);
    expect(found.map((entry) => (entry.payload as { event: { text: string } }).event.text)).toContain("unfinished");
  });
});

describe("staying connected (D135)", () => {
  it("connects again after the connection drops", async () => {
    const { socket: live } = await socket();
    live.receive(0, 1, SIGNAL).catch(() => undefined);
    await until(async () => (await fake.stats()).live === 1, "the first connection");
    const opens = (await fake.stats()).opens;
    await fake.drop();
    await until(async () => (await fake.stats()).opens > opens && (await fake.stats()).live === 1, "a new connection");
    const waiting = live.receive(0, 3, SIGNAL);
    await fake.event({ text: "after the drop" });
    expect((await waiting).map((entry) => (entry.payload as { event: { text: string } }).event.text)).toContain("after the drop");
  });

  it("opens the new connection before closing the old one when Slack asks for a refresh", async () => {
    const { socket: live } = await socket();
    live.receive(0, 1, SIGNAL).catch(() => undefined);
    await until(async () => (await fake.stats()).live === 1, "the first connection");
    const opens = (await fake.stats()).opens;
    await fake.disconnect("refresh_requested");
    await until(async () => (await fake.stats()).opens > opens, "a second connection");
    const waiting = live.receive(0, 3, SIGNAL);
    await fake.event({ text: "after the refresh" });
    expect((await waiting).map((entry) => (entry.payload as { event: { text: string } }).event.text)).toContain("after the refresh");
  });
});

describe("proving that the live connection opens (D135)", () => {
  it("returns the app id Slack sends in its hello, then closes the connection", async () => {
    const url = await slackApi({ bot: BOT_TOKEN, app: APP_TOKEN }, fake.env).connectionsOpen();
    expect(await waitForHello(url, fake.env)).toEqual({ app_id: "A0APP" });
    await until(async () => (await fake.stats()).live === 0, "the probe connection to close");
  });

  it("explains an address it will not use", async () => {
    await expect(waitForHello("wss://evil.example.com/link", {})).rejects.toThrow("not Slack's");
  });

  it("explains a connection that never says hello", async () => {
    await expect(waitForHello("ws://127.0.0.1:1/link", { INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:1", INSTALLER_KEYCHAIN: "file" }, 300)).rejects.toThrow("Socket Mode");
  });
});
