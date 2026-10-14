import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { CHANNEL_FACTS, CHANNEL_IDS, isInternalOnly, loadChannel, openChannel, removeChannel, saveChannel } from "../../src/core/channels.js";
import { channelCommand, describeChannel } from "../../src/core/channel-commands.js";
import { disconnect } from "../../src/core/disconnect.js";
import { runGateway } from "../../src/core/gateway.js";
import { listInbox } from "../../src/core/inbox.js";
import { inviteCommand } from "../../src/core/invite-commands.js";
import { createInvite, listMembers } from "../../src/core/members.js";
import { isPaused, switchRefusal } from "../../src/core/pause.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { channelHome } from "../helpers/channel-home.js";
import { APP_TOKEN, BOT_TOKEN, SLACK_IDS, startFakeSlack, type FakeSlack } from "../helpers/fake-slack.js";
import { makeTempHome } from "../helpers/temp-home.js";

const NOW = "2026-10-14T12:00:00.000Z";
let fake: FakeSlack;
beforeAll(async () => {
  fake = await startFakeSlack();
});
afterAll(() => fake.stop());
const aborts: AbortController[] = [];
afterEach(() => {
  aborts.splice(0).forEach((controller) => controller.abort());
  vi.unstubAllEnvs();
});

async function slackHome() {
  const home = await channelHome(true);
  await removeChannel(home, "telegram");
  const env = { ...fake.env, INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  // The message pipeline reads process.env for its outbound calls, so point it at the Slack fake and the private keychain.
  vi.stubEnv("INSTALLER_CONNECTOR_SERVER", fake.url);
  vi.stubEnv("INSTALLER_KEYCHAIN", "file");
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", env.INSTALLER_KEYCHAIN_DIR);
  await setSecret("slack", JSON.stringify({ bot: BOT_TOKEN, app: APP_TOKEN }), env);
  await saveChannel(home, { channel: "slack", ...SLACK_IDS, verified_at: NOW });
  return { home, env };
}
const until = async (check: () => Promise<boolean>, what: string, ms = 8000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${what}`);
};
function run(home: string, env: Record<string, string>): { stopped: Promise<void> } {
  const controller = new AbortController();
  aborts.push(controller);
  return { stopped: runGateway({ home, env, signal: controller.signal, pollSeconds: 1, pauseMs: 100, now: () => NOW }) };
}

describe("Slack in the registry (D135)", () => {
  it("is a chat app that proves who sent a message, reaches the team only, and pushes events over a live connection", () => {
    expect(CHANNEL_IDS).toContain("slack");
    expect(CHANNEL_FACTS.slack).toEqual({ capabilities: { buttons: false, attachments: [], reply_window: "none", inbound: "socket" }, risk: { official_api: true, outbound_external: false, sender_verified: true } });
    expect(isInternalOnly("slack")).toBe(true);
    expect(isInternalOnly("telegram")).toBe(false);
  });

  it("has everything a channel needs: facts, a connector, a way to join, a note when disconnected", async () => {
    const { home, env } = await slackHome();
    for (const id of CHANNEL_IDS) expect(CHANNEL_FACTS[id]).toBeDefined();
    const connector = await openChannel(home, "slack", env);
    expect(connector.id).toBe("slack");
    await connector.close?.();
    const config = await loadChannel(home, "slack");
    expect(describeChannel(config as never)).toMatchObject({ channel: "slack", workspace: SLACK_IDS.team });
    const invited = (await inviteCommand(home, { decision_maker: "Owner" }, "Sam", true, () => NOW)) as { join: string[]; code: string };
    expect(invited.join.join(" ")).toMatch(/Slack/);
    expect(invited.join.join(" ")).toContain(`JOIN ${invited.code}`);
    expect(invited.join.join(" ")).not.toContain("/join");
  });

  it("deletes both Slack secrets and says what else to do when disconnected", async () => {
    const { home, env } = await slackHome();
    await setSecret("slack-settings", "{}", env);
    const result = (await disconnect(home, "slack", () => NOW)) as { note: string; secret_deleted: boolean };
    expect(result.secret_deleted).toBe(true);
    expect(result.note).toMatch(/Slack/);
    expect(await loadChannel(home, "slack")).toBeNull();
  });

  it("accepts the kill switch from Slack and still refuses it from email", () => {
    const decider = { name: "Sam", role: "decision_maker" } as never;
    expect(switchRefusal(decider, "slack", "pause")).toBeNull();
    expect(switchRefusal(decider, "email", "pause")).toContain("where the sender can be forged");
  });
});

describe("channel.send and Slack (D135)", () => {
  it("is refused before any approval is asked: Slack reaches the team only", async () => {
    const { home } = await slackHome();
    const ctx = await toolContext(home, "mcp", DEFAULT_TOOLS, () => NOW);
    await expect(invokeTool(ctx, "approvals.request", { tool: "channel.send", args: { channel: "slack", to: "U0ADA", text: "hi" }, why: "x" })).rejects.toThrow("your own team only");
  });
});

describe("the gateway reads Slack over one live connection (D135)", () => {
  it("joins a member who sends JOIN in a direct message, welcomes them by DM, and keeps their messages", async () => {
    const { home, env } = await slackHome();
    const { code } = await createInvite(home, "Sam", { decision_maker: "Sam" }, NOW);
    const gateway = run(home, env);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    await fake.event({ user: "U0SAM", text: `JOIN ${code}`, channel: "D0SAM" });
    await until(async () => (await listMembers(home, NOW)).some((member) => member.name === "Sam" && member.status === "joined"), "Sam joined");
    await until(async () => (await fake.sent()).some((message) => message.channel === "U0SAM"), "the welcome message");
    expect((await fake.sent()).find((message) => message.channel === "U0SAM")?.text).toBeTruthy();
    await fake.event({ user: "U0SAM", text: "what is on today?", channel: "D0SAM" });
    await until(async () => (await listInbox(home)).some((item) => item.text === "what is on today?"), "the message");
    const item = (await listInbox(home)).find((entry) => entry.text === "what is on today?");
    expect(item).toMatchObject({ channel: "slack", from: "u0sam", route: "conversation", member: "Sam" });
    expect((await fake.stats()).opens).toBe(1);
    expect(gateway.stopped).toBeDefined();
  });

  it("lets the decision maker pause everything with the bare word", async () => {
    const { home, env } = await slackHome();
    const { code } = await createInvite(home, "Sam", { decision_maker: "Sam" }, NOW);
    run(home, env);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    await fake.event({ user: "U0SAM", text: `JOIN ${code}`, channel: "D0SAM" });
    await until(async () => (await listMembers(home, NOW)).some((member) => member.name === "Sam" && member.status === "joined"), "Sam joined");
    await fake.event({ user: "U0SAM", text: "pause", channel: "D0SAM" });
    await until(() => isPaused(home), "the pause");
  });

  it("closes the live connection when the gateway stops", async () => {
    const { home, env } = await slackHome();
    const controller = new AbortController();
    const stopped = runGateway({ home, env, signal: controller.signal, pollSeconds: 1, pauseMs: 100, now: () => NOW });
    await until(async () => (await fake.stats()).live === 1, "the connection");
    controller.abort();
    await stopped;
    await until(async () => (await fake.stats()).live === 0, "the connection to close");
  });

  it("sends a notification to a member by direct message, using their upper-case Slack id", async () => {
    const { home, env } = await slackHome();
    const { code } = await createInvite(home, "Sam", { decision_maker: "Sam" }, NOW);
    run(home, env);
    await until(async () => (await fake.stats()).live === 1, "the connection");
    await fake.event({ user: "U0SAM", text: `JOIN ${code}`, channel: "D0SAM" });
    await until(async () => (await listMembers(home, NOW)).some((member) => member.name === "Sam" && member.status === "joined"), "Sam joined");
    const before = (await fake.sent()).length;
    const ctx = await toolContext(home, "gateway", DEFAULT_TOOLS, () => NOW);
    await invokeTool(ctx, "channel.notify", { member: "Sam", text: "Weekly note <!channel>" });
    // The running gateway may send other messages too (a welcome, an approval notice): find this one by its text.
    await until(async () => (await fake.sent()).slice(before).some((message) => message.text.startsWith("Weekly note")), "the notification");
    const note = (await fake.sent()).slice(before).find((message) => message.text.startsWith("Weekly note"));
    expect(note).toMatchObject({ channel: "U0SAM", text: "Weekly note &lt;!channel&gt;", parse: "none" });
    expect(await readFile(join(home, "config", "channels", "slack.json"), "utf8")).not.toContain(BOT_TOKEN);
  });
});

describe("taskfollow channel slack (D135)", () => {
  const SETTINGS = JSON.stringify({ team_id: SLACK_IDS.team_id, team: SLACK_IDS.team, bot_user_id: SLACK_IDS.bot_user_id, app_id: SLACK_IDS.app_id });

  async function fresh(handoff?: string) {
    const home = await channelHome(true);
    await removeChannel(home, "telegram");
    const env = { ...fake.env, INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    vi.stubEnv("INSTALLER_CONNECTOR_SERVER", fake.url);
    vi.stubEnv("INSTALLER_KEYCHAIN", "file");
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", env.INSTALLER_KEYCHAIN_DIR);
    await setSecret("slack", JSON.stringify({ bot: BOT_TOKEN, app: APP_TOKEN }), env);
    if (handoff) await setSecret("slack-settings", handoff, env);
    return { home, env };
  }

  it("checks the tokens against what the setup page stored, saves the channel without any token, and deletes the hand-off", async () => {
    const { home, env } = await fresh(SETTINGS);
    expect(await channelCommand(home, "slack", undefined, () => NOW, env, false)).toMatchObject({ status: "verified", channel: "slack", workspace: SLACK_IDS.team });
    expect(await loadChannel(home, "slack")).toMatchObject({ channel: "slack", team_id: SLACK_IDS.team_id, app_id: SLACK_IDS.app_id, bot_user_id: SLACK_IDS.bot_user_id });
    expect(JSON.stringify(await loadChannel(home, "slack"))).not.toContain("xoxb");
    expect(await getSecret("slack-settings", env)).toBeNull();
  });

  it("checks the saved channel again when there is no hand-off", async () => {
    const { home, env } = await fresh(SETTINGS);
    await channelCommand(home, "slack", undefined, () => NOW, env, false);
    expect(await channelCommand(home, "slack", undefined, () => NOW, env, false)).toMatchObject({ status: "verified" });
  });

  it("says to run the setup page when nothing was set up", async () => {
    const { home, env } = await fresh();
    await expect(channelCommand(home, "slack", undefined, () => NOW, env, false)).rejects.toThrow("taskfollow secret slack");
  });

  it("refuses tokens that belong to a different workspace or app than the one set up", async () => {
    const { home, env } = await fresh(JSON.stringify({ team_id: "T0OTHER", team: "Other", bot_user_id: "U0BOT", app_id: "A0APP" }));
    await expect(channelCommand(home, "slack", undefined, () => NOW, env, false)).rejects.toThrow("different workspace or app");
    expect(await loadChannel(home, "slack")).toBeNull();
  });

  it("takes no --value", async () => {
    const { home, env } = await fresh(SETTINGS);
    await expect(channelCommand(home, "slack", "{}", () => NOW, env, true)).rejects.toThrow("takes no --value");
  });

  it("says plainly when Slack no longer accepts the tokens", async () => {
    const { home, env } = await fresh(SETTINGS);
    await setSecret("slack", JSON.stringify({ bot: "xoxb-revoked", app: "xapp-revoked" }), env);
    await expect(channelCommand(home, "slack", undefined, () => NOW, env, false)).rejects.toThrow("taskfollow secret slack");
  });
});
