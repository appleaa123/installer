import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfig } from "../../src/core/data-source.js";
import { checkDelivered, deliverToCowork, scheduleWords } from "../../src/core/deliver.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadState, saveState } from "../../src/core/state.js";
import { readZip, storedZip } from "../../src/core/zip.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";
import { recordResult } from "../../src/core/checks.js";
import { confirmDescribed, descriptionHash, workflowHash } from "../../src/core/homes.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Plan Task 9 (spec section 10, D158): a workflow for Claude Cowork as a skill zip plus schedule text, checked first. */
const AT = "2026-10-16T12:00:00.000Z";
const brief = (description: string, extra: Record<string, unknown> = {}) => parseWorkflow({ workflow: "morning-brief", version: 1, description, mode: "agentic", instructions: description, tools: ["channel.inbox"], trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, ...extra }, "morning-brief", DEFAULT_TOOLS);

const COWORK = { agent: "Claude Cowork", version: null };
const RUNNER = { agent: "fake-agent", version: "9.9.9" };
const raw = (description: string, extra: Record<string, unknown> = {}) => ({ workflow: "morning-brief", version: 1, description, mode: "agentic", instructions: description, tools: ["channel.inbox"], trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, ...extra });

async function install() {
  const home = await runnerHome();
  const work = await makeTempHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  return { home, work };
}

/** Review B2: delivery follows the home decision, so the tests set up a confirmed report-only workflow with a fresh T8 on Cowork. */
async function readyForCowork(home: string, description: string): Promise<void> {
  await writeWorkflow(home, raw(description));
  await confirmDescribed(home, "morning-brief", descriptionHash(description), workflowHash(raw(description)), { sendsToOthers: false, writesOrDeletes: false }, AT);
  await recordResult(home, { need: "scheduler", workflow: "morning-brief", result: "yes-you-told-us", reason: "you told us", at: AT, agent: "Claude Cowork", agent_version: null, test: "t8", while_away: true });
}
const deliver = (home: string, description: string) => deliverToCowork(home, brief(description), { now: AT, agent: COWORK, runner: RUNNER });

describe("zip: a small stored zip with a real central directory (plan review 11)", () => {
  it("round-trips names and bytes, with CRCs that a reader checks", () => {
    const zip = storedZip([{ name: "a/", data: Buffer.alloc(0) }, { name: "a/SKILL.md", data: Buffer.from("hello\n") }]);
    expect(readZip(zip)).toEqual([{ name: "a/", data: Buffer.alloc(0) }, { name: "a/SKILL.md", data: Buffer.from("hello\n") }]);
  });
});

describe("deliver: a workflow for Claude Cowork (plan Task 9)", () => {
  it("writes one top folder with SKILL.md at its top and no plugin manifest, rules inside, and the schedule text with its footer", async () => {
    const { home, work } = await install();
    const rules = join(work, ".claude", "skills", "morning-brief", "references");
    await mkdir(rules, { recursive: true });
    await writeFile(join(work, ".claude", "skills", "morning-brief", "SKILL.md"), "---\nname: morning-brief\ndescription: Use for the owner's morning brief.\n---\n\nRead my inbox and tell me what needs a visit.\n");
    await writeFile(join(rules, "my-rules.md"), "# My rules\n\nFlag repairs first.\n");
    await readyForCowork(home, "Read my inbox each morning and tell me what needs a visit.");
    const out = await deliver(home, "Read my inbox each morning and tell me what needs a visit.");
    const entries = readZip(await readFile(out.zip));
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(["morning-brief/", "morning-brief/SKILL.md"]);
    expect(names.some((name) => name.includes(".claude-plugin"))).toBe(false);
    const skill = entries[1]?.data.toString("utf8") ?? "";
    expect(skill).toMatch(/^---\nname: morning-brief\n/);
    expect(skill).toContain("Flag repairs first.");
    expect(out.schedule).toContain("every weekday at 08:00 (America/Toronto)");
    expect(out.schedule).toContain("Sent by your scheduled TaskFollow workflow morning-brief");
    expect(out.schedule).toContain("SendUserMessage");
    expect(out.steps.join(" ")).toContain("Settings, then Skills");
    expect(out.steps.join(" ")).toContain("Cowork cannot delete them from a chat");
  });

  it("generates the skill from the description when the install folder has none", async () => {
    const { home } = await install();
    await readyForCowork(home, "Read my inbox and list what matters.");
    const out = await deliver(home, "Read my inbox and list what matters.");
    expect(readZip(await readFile(out.zip))[1]?.data.toString("utf8")).toContain("Read my inbox and list what matters.");
  });

  it.each([
    ["a keychain value", "Use the token tg-real-secret-123456 to read."],
    ["a token pattern", "Call with ghp_abcdefghijklmnop1234 please."],
    ["a local path", "Read the file /Users/someone/notes.txt each morning."],
    ["a taskfollow command", "Then run taskfollow approvals list for me."],
  ])("refuses %s in the delivered text, without repeating it", async (_kind, description) => {
    const { home } = await install();
    await setSecret("telegram", "tg-real-secret-123456");
    await readyForCowork(home, description);
    const failed = deliver(home, description);
    await expect(failed).rejects.toThrow(/remove it from the workflow's description or rules/);
    await expect(failed).rejects.not.toThrow(/tg-real-secret|ghp_abc/);
  });

  it("keeps one rules heading and no pointer to a references folder the zip does not have (review M1)", async () => {
    const { home } = await install();
    await readyForCowork(home, "Read my inbox and list what matters.");
    const skill = readZip(await readFile((await deliver(home, "Read my inbox and list what matters.")).zip))[1]?.data.toString("utf8") ?? "";
    expect(skill.match(/## The owner's own rules/g)).toHaveLength(1);
    expect(skill).not.toContain("references/my-rules.md");
  });

  it.each([
    ["a bot's name", "Ask owner_private_bot for help each morning."],
    ["a mail server", "Connect to imap.mailhost-example.com first."],
  ])("refuses %s nested in a channel's settings (review H3)", async (_kind, description) => {
    const { home } = await install();
    await writeConfig(home, join("config", "channels", "telegram.json"), { channel: "telegram", verified_at: AT, bot: { username: "owner_private_bot", id: 42 } });
    await writeConfig(home, join("config", "channels", "email.json"), { channel: "email", verified_at: AT, address: "me@example.com", imap: { host: "imap.mailhost-example.com", port: 993 } });
    await readyForCowork(home, description);
    const failed = deliver(home, description);
    await expect(failed).rejects.toThrow(/a key or a channel setting from this computer/);
    await expect(failed).rejects.not.toThrow(/owner_private_bot|mailhost-example/);
  });

  it("still allows the person's own address in the delivered text (review H3)", async () => {
    const { home } = await install();
    await writeConfig(home, join("config", "channels", "email.json"), { channel: "email", verified_at: AT, address: "me@example.com", imap: { host: "imap.mailhost-example.com", port: 993 } });
    await readyForCowork(home, "Read my inbox at me@example.com and list what matters.");
    await expect(deliver(home, "Read my inbox at me@example.com and list what matters.")).resolves.toMatchObject({ skill: "morning-brief" });
  });

  it("refuses to deliver work nobody confirmed as report-only, naming why (review B2)", async () => {
    const { home } = await install();
    await writeWorkflow(home, raw("Read my inbox and list what matters."));
    await expect(deliver(home, "Read my inbox and list what matters.")).rejects.toThrow(/Not delivered: .*nobody has confirmed yet/);
  });

  it("refuses to deliver hard-rule work even with every check passed (review B2)", async () => {
    const { home } = await install();
    const description = "Reply to each customer in my inbox.";
    const hard = raw(description, { tools: ["channel.inbox", "channel.send"] });
    await writeWorkflow(home, hard);
    await confirmDescribed(home, "morning-brief", descriptionHash(description), workflowHash(hard), { sendsToOthers: false, writesOrDeletes: false }, AT);
    await recordResult(home, { need: "scheduler", workflow: "morning-brief", result: "yes-you-told-us", reason: "you told us", at: AT, agent: "Claude Cowork", agent_version: null, test: "t8", while_away: true });
    await expect(deliverToCowork(home, brief(description, { tools: ["channel.inbox", "channel.send"] }), { now: AT, agent: COWORK, runner: RUNNER })).rejects.toThrow(/Not delivered: Draft-only/);
  });

  it("says schedules in plain words", () => {
    expect(scheduleWords({ kind: "cron", cron: "30 7 * * *", tz: "Europe/London", tolerance_minutes: 5 })).toBe("every day at 07:30 (Europe/London)");
    expect(scheduleWords({ kind: "cron", cron: "0 9 * * 1", tz: "UTC", tolerance_minutes: 5 })).toBe("every Monday at 09:00 (UTC)");
    expect(scheduleWords({ kind: "manual" })).toBe("every weekday at 08:00, or at the time you prefer");
  });
});

describe("deliver: the shipped inbox triage skill (item 5)", () => {
  const ID = "inbox-triage";
  const DESCRIPTION = "Every morning, read the mail that arrived since you last did this (or in the last 24 hours) and tell me what needs me.";
  const triage = { ...raw(DESCRIPTION), workflow: ID };
  const shipped = (id: string) => readFile(join(process.cwd(), "solutions", "shapes", id, "SKILL.md"), "utf8");

  it.each(["inbox-triage", "inbox-triage-replies"])("shipped shape skills pass checkDelivered (%s)", async (id) => {
    const { home } = await install();
    await expect(checkDelivered(home, await shipped(id))).resolves.toBeUndefined();
  });

  it("the delivered inbox-triage SKILL.md holds the owner's rules under The owner's own rules and no pointer line", async () => {
    const { home, work } = await install();
    const folder = join(work, ".claude", "skills", ID);
    await mkdir(join(folder, "references"), { recursive: true });
    await writeFile(join(folder, "SKILL.md"), await shipped(ID));
    await writeFile(join(folder, "references", "my-rules.md"), "# My rules for inbox-triage\n\nRepairs at 12 Oak St come first.\n");
    await writeFile(join(folder, "references", "examples.md"), "# Examples for inbox-triage\n\nTom asks for the lease copy: reply.\n");
    await writeWorkflow(home, triage);
    await confirmDescribed(home, ID, descriptionHash(DESCRIPTION), workflowHash(triage), { sendsToOthers: false, writesOrDeletes: false }, AT);
    await recordResult(home, { need: "scheduler", workflow: ID, result: "yes-you-told-us", reason: "you told us", at: AT, agent: "Claude Cowork", agent_version: null, test: "t8", while_away: true });
    const out = await deliverToCowork(home, parseWorkflow(triage, ID, DEFAULT_TOOLS), { now: AT, agent: COWORK, runner: RUNNER });
    const skill = readZip(await readFile(out.zip))[1]?.data.toString("utf8") ?? "";
    expect(skill).toContain("## The owner's own rules\n\nRepairs at 12 Oak St come first.");
    expect(skill).not.toContain("references/");
    expect(skill).toContain("since you last did this (or in the last 24 hours");
    expect(out.schedule).toContain("since you last did this (or in the last 24 hours)");
  });
});
