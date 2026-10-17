import { guideCommand } from "../../src/core/guide-commands.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { channelCommand } from "../../src/core/channel-commands.js";
import { listInbox } from "../../src/core/inbox.js";
import { loadChannel, saveChannel } from "../../src/core/channels.js";
import { dryrunCommand } from "../../src/core/lifecycle.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { usesSkillswiki } from "../../src/core/skillswiki.js";
import { installerCliPath } from "../../src/core/register.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { WA, startFakeWhatsApp, textPayload, type FakeWhatsApp } from "../helpers/fake-whatsapp.js";
import { APP_TOKEN, BOT_TOKEN as SLACK_BOT_TOKEN, SLACK_IDS, startFakeSlack, type FakeSlack } from "../helpers/fake-slack.js";
import { MAIL_PASSWORD, MAIL_USER, TEST_TLS_ENV, startFakeImap, startFakeSmtp, type FakeServer } from "../helpers/fake-mail.js";
import { BOT_TOKEN } from "../helpers/fake-telegram.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, operate, starterScript } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "add", "next", "submit", "verify", "resume", "report", "probe", "secret", "guide", "disconnect", "tool", "approvals", "connect", "map", "channel", "invite", "members", "gateway", "run", "schedule", "model", "workflow", "dryrun", "sandbox", "harden", "autonomy", "alerts", "learnings", "doctor", "pause", "unpause", "host", "packs", "retention", "support", "uninstall"];

describe("START-HERE.md, the page for the person (D129)", () => {
  const START = readFileSync("START-HERE.md", "utf8");

  it("gets from nothing to a running agent, then hands over with one sentence", () => {
    for (const step of ["nodejs.org", "npm install -g @anthropic-ai/claude-code", "claude", "npx --yes taskfollow instructions"]) expect(START).toContain(step);
    expect(START.indexOf("nodejs.org")).toBeLessThan(START.indexOf("npm install -g @anthropic-ai/claude-code"));
    expect(START.indexOf("npm install -g @anthropic-ai/claude-code")).toBeLessThan(START.indexOf("npx --yes taskfollow instructions"));
  });

  it("says what to have on hand and never to paste a password or key into the chat", () => {
    expect(START).toMatch(/Google account/);
    expect(START).toMatch(/the helper asks/i);
    expect(START).toMatch(/Telegram/);
    expect(START).toMatch(/never paste/i);
  });

  it("covers both computers and how to get back after a closed window", () => {
    expect(START).toMatch(/Mac/);
    expect(START).toMatch(/Windows/);
    expect(START).toContain("claude --continue");
  });

  it("uses no jargon the person would not know", () => {
    expect(START).not.toMatch(/\b(MCP|OAuth|keychain|JSON|API|IMAP|SMTP|CLI|launchd|schtasks)\b/);
  });
});

describe("INSTALL.md", () => {
  it("says any agent without TaskFollow's MCP server uses taskfollow tool (D175)", () => {
    expect(DOC).toContain("Only Claude Code has TaskFollow's tools registered as an MCP server; any other agent uses `taskfollow tool <name> '<json arguments>'`");
  });

  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify", "6. Never approve, edit or reject an approval yourself"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("operator rule 11 says the why tool may be used instead of the command (D169)", () => {
    const rule = DOC.slice(DOC.indexOf("11. At the start of each session"), DOC.indexOf("\n12. "));
    expect(rule).toContain("If you reach TaskFollow through its tools rather than a shell, `approvals.list`, and `why.show` with `since` set to that day, give the same answers; a run's whole result is `why.show` with `run` set to its id.");
  });

  it("INSTALL.md has operator rule 14, the opportunity rule (9.4, D172)", () => {
    expect(DOC).toContain("14. When you notice work that repeats, in what the person asks you to do, in what a workflow's results show, or in a suggestion TaskFollow noticed, say so in one sentence and show the workflow you would set up: what starts it, what it reads, what it may change, and what waits for their yes. If they give feedback, change it and show it again. Add it only after they say yes; never create, change or turn on a workflow without one. Propose each kind of work once; propose it again only if they ask.");
  });

  it("INSTALL.md has operator rule 15 with workflow rule, the yes and the scheduled-workflow question (item 8, D173)", () => {
    const rule = DOC.slice(DOC.indexOf("15. When the person edits or rejects a result"));
    expect(rule).toContain("propose one short rule for that workflow's `references/my-rules.md`, in their words, and show it.");
    expect(rule).toContain("Add it with `taskfollow workflow rule <id> --value '{\"rule\":\"…\"}'` only after they say yes, then tell them the exact text that was added.");
    expect(rule).toContain("A rule never changes what needs their approval.");
    expect(rule).toContain("Never run `workflow rule` without their yes to that exact text; if they change the wording, show it again.");
    expect(rule).toContain("At the start of a session, also ask whether they corrected a result of a workflow that runs on their assistant's own schedule");
  });

  it("operator rules are numbered 1 to 15 without gaps", () => {
    const rules = DOC.slice(DOC.indexOf("## Operator rules")).split("\n").map((line) => /^(\d+)\. /.exec(line)?.[1]).filter((number): number is string => number !== undefined).map(Number);
    expect(rules).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
  });

  it("rule 11 says rule candidates stay listed until closed", () => {
    const rule = DOC.slice(DOC.indexOf("11. At the start of each session"), DOC.indexOf("\n12. "));
    expect(rule).toContain("If it lists corrections to turn into rules, they stay listed until a rule is added or the person says no (rule 15).");
  });

  it("keeps one placeholder, for the optional Skills Wiki URL, after the optional section starts (D129)", () => {
    const optional = DOC.indexOf("## 11.");
    expect(optional).toBeGreaterThan(0);
    expect(DOC.indexOf("{{SKILLSWIKI_URL}}")).toBeGreaterThan(optional);
    expect(DOC.indexOf("taskfollow secret skillswiki")).toBeGreaterThan(optional);
    expect(DOC.indexOf("taskfollow secret skillswiki")).toBeLessThan(DOC.indexOf("--url {{SKILLSWIKI_URL}}"));
    expect(DOC).toContain("--solution starter-skillswiki");
  });

  it("sets up email through the page: no JSON for the person to type, and the page comes before the channel check (D127)", () => {
    const channels = DOC.slice(DOC.indexOf("## 7."), DOC.indexOf("## 8."));
    expect(channels).not.toContain("--value '{");
    expect(channels).not.toContain("IMAP and SMTP servers, then ask");
    expect(channels.indexOf("taskfollow secret email")).toBeGreaterThan(-1);
    expect(channels.indexOf("taskfollow secret email")).toBeLessThan(channels.indexOf("taskfollow channel email"));
    expect(channels).toContain("Outlook");
    expect(channels).toContain("Telegram");
  });

  it("handles Windows as a Preview: detects the system without uname, uses Command Prompt, and says what is missing (D128)", () => {
    expect(DOC).not.toContain("`uname`");
    expect(DOC).toContain("node -p process.platform");
    expect(DOC).toContain("win32");
    expect(DOC).toMatch(/Windows.{0,40}Preview/);
    expect(DOC).toContain("Command Prompt");
    expect(DOC).toMatch(/Windows key/);
    expect(DOC).not.toMatch(/On Windows, stop/);
    expect(DOC).toMatch(/team host.{0,80}Windows|Windows.{0,80}team host/s);
  });

  it("is ready to run as written: real commands, no placeholders in the base path (D129)", () => {
    const base = DOC.slice(0, DOC.indexOf("## 11."));
    expect(base).not.toContain("{{");
    expect(base).toContain("npm install -g taskfollow");
    expect(base).toContain("taskfollow start --solution starter\n");
    expect(base).toMatch(/EACCES|permission denied/i);
    expect(base).toContain("sudo npm install -g taskfollow");
  });

  it("lists everything the person needs before starting, Telegram and Claude Code included", () => {
    const before = DOC.slice(DOC.indexOf("## Before you start"), DOC.indexOf("## 1."));
    expect(before).toMatch(/Telegram/);
    expect(before).toMatch(/Claude Code/);
    expect(before).toMatch(/quit Claude Code and open it again/i);
  });

  it("tells the person to use a new window for their own commands, not the agent's prompt", () => {
    expect(DOC).toMatch(/new (terminal )?window/i);
  });

  it("tells the agent how to handle the choice questions and a person on their own (D131)", () => {
    expect(DOC).toMatch(/not sure/i);
    expect(DOC).toContain("`default`");
    expect(DOC).toMatch(/on their own/i);
    expect(DOC).toMatch(/nobody else is invited/);
  });

  it("never asks for Skills Wiki before the optional section", () => {
    const base = DOC.slice(0, DOC.indexOf("## 11."));
    expect(base).not.toMatch(/skills ?wiki/i);
    expect(base).not.toContain("--url");
  });

  it("only names commands the CLI has", () => {
    const named = [...DOC.matchAll(/(?:^|`)installer ([\w-]+)/gm)].map((match) => match[1]);
    expect(named.filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("the shipped starter loads, probes with the bundled profiles and needs no Skills Wiki (D126)", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    expect(starter.steps[0]?.auto).toEqual({ action: "probe_runtime", args: {} });
    expect(starter.steps.some((step) => step.step_id.startsWith("brain."))).toBe(false);
    expect(starter.steps.map((step) => step.step_id)).toEqual(expect.arrayContaining(["preflight.tools", "data.google", "data.connect", "channels.telegram", "activate.schedule"]));
    expect(starter.steps.map((step) => step.phase)).toEqual(expect.arrayContaining(["CHANNELS", "WORKFLOWS", "DRY_RUN", "ACTIVATE"]));
    expect(starter.workflows?.map((workflow) => workflow.workflow)).toEqual(["contacts-summary", "weekly-note", "inbox-triage", "inbox-triage-replies", "lead-qualification", "crm-update", "invoice-processing", "invoices-due", "meeting-follow-up"]);
    expect(Object.keys(starter.data_contract?.entities.contact?.fields ?? {})).toEqual(["name", "email", "notes"]);
    expect(usesSkillswiki(starter)).toBe(false);
  });

  it.each(["solutions/starter.json", "solutions/starter-skillswiki.json"])("%s lets the schedule block the install and runs its workflow in the computer's own zone (D130)", (file) => {
    const starter = parseSolution(JSON.parse(readFileSync(file, "utf8")));
    expect(starter.steps.find((step) => step.step_id === "activate.schedule")?.blocking).toBe(true);
    expect(JSON.stringify(starter.workflows)).toContain('"tz":"local"');
    expect(JSON.stringify(starter.workflows)).not.toContain('"tz":"UTC"');
  });

  it("the Skills Wiki starter keeps the BRAIN steps for people who have an account", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter-skillswiki.json", "utf8")));
    expect(starter.id).toBe("starter-skillswiki");
    expect(starter.steps.map((step) => step.step_id)).toEqual(expect.arrayContaining(["brain.key", "brain.register", "brain.combo", "brain.probe-mcp"]));
    expect(usesSkillswiki(starter)).toBe(true);
  });

  it("every guide the starter names has a setup block and is printed by taskfollow guide", async () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    const guides = starter.steps.flatMap((step) => (step.guide ? [step.guide] : []));
    expect(guides).toEqual(["google-sheets"]);
    for (const id of guides) await expect(guideCommand(id)).resolves.toMatchObject({ connector: id });
  });

  it("proves the Google sign-in right after it is stored", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    const ids = starter.steps.map((step) => step.step_id);
    expect(ids.indexOf("data.google-ready")).toBe(ids.indexOf("data.google") + 1);
    expect(starter.steps.find((step) => step.step_id === "data.google-ready")?.verify).toEqual({ check: "oauth_ready", args: { id: "google" } });
  });
});

/** Asynchronous on purpose: the fake mail servers live in this process and must keep answering while the gateway shuts down. */
const stopGateway = (home: string, env: Record<string, string>): Promise<void> =>
  new Promise((done) => {
    execFile(process.execPath, [resolve("dist/cli.js"), "--home", home, "gateway", "stop"], { env: { ...process.env, ...env } }, () => done());
  });

describe("starter install, operated the way INSTALL.md says", () => {
  const servers: (FakeMcp | FakeGoogle | FakeSlack | FakeWhatsApp)[] = [];
  const installs: { home: string; env: Record<string, string> }[] = [];

  const mailFakes: FakeServer[] = [];
  afterEach(async () => {
    // The gateway holds a connection to the fake mail server: stop it first, or the server waits for it for ever.
    await Promise.all(installs.splice(0).map(({ home, env }) => stopGateway(home, env)));
    await Promise.all(mailFakes.splice(0).map((fake) => fake.stop()));
    servers.splice(0).forEach((fake) => fake.stop());
  });

  /**
   * CHANNELS to ACTIVATE (D98): the person stores the bot token, the channel is checked (written directly here: the
   * one test connector server is the fake Google), the decision maker joins, a suggested workflow is added, dry-run
   * and confirmed in the person's terminal, and the OS scheduler's first tick is simulated with 'taskfollow tick'.
   */
  function lifecycleSteps(keychain: Record<string, string>, env: Record<string, string>, flow: { workflow: string; owner: string } = { workflow: "contacts-summary", owner: "Owner" }) {
    const cli = (args: string[]) => async (home: string): Promise<void> => {
      const result = runCli(args, { home, env });
      if (result.code !== 0) throw new Error(`taskfollow ${args.join(" ")} failed: ${result.stderr}`);
    };
    const now = (): string => new Date().toISOString();
    const join = async (home: string): Promise<void> => {
      const { code } = await createInvite(home, flow.owner, { decision_maker: flow.owner }, now());
      await joinWithCode(home, code, { channel: "telegram", address: "1002" }, now());
    };
    return {
      "channels.telegram-key": () => setSecret("telegram", BOT_TOKEN, keychain),
      "channels.telegram": (home: string) => saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: now() }),
      "channels.join": join,
      "channels.join-solo": join,
      "workflows.choose": cli(["workflow", "add", flow.workflow]),
      "dryrun.run": cli(["dryrun"]),
      "dryrun.confirm": async (home: string) => void (await dryrunCommand(home, "confirm", flow.workflow, { interactive: true, as: flow.owner }, now)),
      "activate.schedule": cli(["tick"]),
    };
  }

  /** The agent's calls in the dry run of contacts-summary: read the contacts and the members, tell the decision maker. */
  const AGENT_CALLS = JSON.stringify([
    { tool: "records.find", args: { entity: "contact" } }, { tool: "channel.list", args: {} },
    { tool: "channel.notify", args: { member: "Owner", text: "0 contacts" } }, { tool: "done", summary: "Told Owner" },
  ]);

  /** The agent's DATA actions as INSTALL.md section 6 says: the person signs in, the agent connects a new sheet and maps it. */
  function dataSteps(keychain: Record<string, string>, env: Record<string, string>) {
    const ok = (args: string[]) => async (home: string): Promise<void> => {
      const result = runCli(args, { home, env });
      if (result.code !== 0) throw new Error(`taskfollow ${args.join(" ")} failed: ${result.stderr}`);
    };
    return {
      "data.google": () => setSecret("google", SIGNED_IN, keychain),
      "data.connect": ok(["connect", "contact", "--sheet", "new"]),
      "data.map": ok(["map", "contact", "--value", JSON.stringify({ name: "name", email: "email", notes: "notes" })]),
    };
  }

  /** A fake Skills Wiki, a fake Google, a private keychain folder and a private fake-agent config folder for one install. */
  async function setup(extraEnv: Record<string, string> = {}) {
    const fake = await startFakeMcp();
    const google = await startFakeGoogle();
    servers.push(fake, google);
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const agentHome = await makeTempHome();
    const env = { ...keychain, ...google.env, FAKE_AGENT_HOME: agentHome, FAKE_AGENT_JUDGE: AGENT_CALLS, ...extraEnv };
    const script = starterScript(() => setSecret("skillswiki", fake.key, keychain), { ...dataSteps(keychain, env), ...lifecycleSteps(keychain, env) });
    return { fake, env, keychain, script, registration: join(agentHome, "mcp", "skillswiki.json") };
  }

  it("the shipped starter completes with no Skills Wiki: no key, no --url, nothing registered (D126)", async () => {
    const google = await startFakeGoogle();
    servers.push(google);
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const env = { ...keychain, ...google.env, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: AGENT_CALLS };
    const script = {
      answers: { "mode.purpose": "install", "mode.who": "team", "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner", "services.records": "google-sheets", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" },
      perform: { ...dataSteps(keychain, env), ...lifecycleSteps(keychain, env) },
    };
    const home = await makeTempHome();
    installs.push({ home, env });
    // The shipped starter, with only the test agent pinned: the shipped file lets the probe find a real agent on the machine.
    const shipped = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { steps: { auto?: { args?: Record<string, unknown> } }[] };
    const probe = shipped.steps[0]?.auto;
    if (probe) probe.args = { profile: "fake-agent" };
    const pinned = join(await makeTempHome(), "starter.json");
    await writeFile(pinned, JSON.stringify(shipped), "utf8");
    const run = await operate({ home, solutionRef: `file:${pinned}`, script, startArgs: [], env });
    expect(run.final.status).toBe("complete");
    expect((await loadState(home))?.skillswiki).toBeUndefined();
    expect(await getSecret("skillswiki", keychain)).toBeNull();
    expect(JSON.stringify(run.calls.map((call) => call.stdout))).not.toMatch(/skills ?wiki/i);
    expect(runCli(["doctor"], { home, env }).stdout).not.toMatch(/skills ?wiki/i);
    expect(runCli(["report"], { home, env }).stdout).not.toMatch(/skills ?wiki|MCP not checked/i);
  });

  /** The shipped starter with only the test agent pinned: the shipped file lets the probe find a real agent on the machine. */
  async function pinnedStarter(): Promise<string> {
    const shipped = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { steps: { auto?: { args?: Record<string, unknown> } }[] };
    const probe = shipped.steps[0]?.auto;
    if (probe) probe.args = { profile: "fake-agent" };
    const pinned = join(await makeTempHome(), "starter.json");
    await writeFile(pinned, JSON.stringify(shipped), "utf8");
    return pinned;
  }

  it("a person on their own with no contact list is never asked about teams, decision makers or Google (D131)", async () => {
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const solo = JSON.stringify([
      { tool: "memo.list", args: {} }, { tool: "channel.list", args: {} },
      { tool: "channel.notify", args: { member: "Sam", text: "No memos" } }, { tool: "done", summary: "Told Sam" },
    ]);
    const env = { ...keychain, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: solo };
    const script = {
      answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "telegram", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" },
      perform: lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }),
    };
    const home = await makeTempHome();
    installs.push({ home, env });
    const run = await operate({ home, solutionRef: `file:${await pinnedStarter()}`, script, startArgs: [], env });
    expect(run.final.status).toBe("complete");
    const shown = JSON.stringify(run.calls.map((call) => call.stdout));
    for (const hidden of ["mode.shared-work", "mode.decision-maker", "data.google", "data.connect", "data.map"]) expect(shown).not.toContain(hidden);
    const state = await loadState(home);
    expect(state).toMatchObject({ mode: "personal", roles: { decision_maker: "Sam" } });
    expect(state?.steps["data.google"]).toBeUndefined();
    const report = runCli(["report"], { home, env }).stdout;
    expect(report).not.toMatch(/decision maker/i);
    // Google may be offered under "Can add", but is never a step of this person's setup.
    expect(report.split("\n").filter((line) => !line.includes("Can add"))).not.toEqual(expect.arrayContaining([expect.stringMatching(/google/i)]));
  });

  it("a person on their own with no channel at all finishes the install with no channel step (9.12 item 3)", async () => {
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const alone = JSON.stringify([{ tool: "memo.list", args: {} }, { tool: "channel.list", args: {} }, { tool: "done", summary: "No memos this week" }]);
    const env = { ...keychain, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: alone };
    const script = {
      answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "none", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" },
      perform: lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }),
    };
    const home = await makeTempHome();
    installs.push({ home, env });
    const run = await operate({ home, solutionRef: `file:${await pinnedStarter()}`, script, startArgs: [], env });
    expect(run.final.status).toBe("complete");
    const shown = JSON.stringify(run.calls.map((call) => call.stdout));
    for (const hidden of ["channels.telegram", "channels.gateway", "channels.join-solo", "activate.gateway"]) expect(shown).not.toContain(hidden);
  });

  /** The person's email steps, with a fake mail server: the page's hand-off is written to the keychain as the page would. */
  async function emailSteps(keychain: Record<string, string>, env: Record<string, string>) {
    const imap = await startFakeImap("ssl", []);
    const smtp = await startFakeSmtp("starttls");
    mailFakes.push(imap, smtp);
    return {
      "channels.email-key": async (): Promise<void> => {
        await setSecret("email", MAIL_PASSWORD, keychain);
        await setSecret("email-settings", JSON.stringify({ address: MAIL_USER, imap: { host: "127.0.0.1", port: imap.port, security: "ssl" }, smtp: { host: "127.0.0.1", port: smtp.port, security: "starttls" } }), keychain);
      },
      // In this process, not through the command line: the fake mail servers live here, and a spawned child would wait for them while this process waits for the child.
      "channels.email": async (home: string): Promise<void> => void (await channelCommand(home, "email", undefined, () => new Date().toISOString(), env, false)),
    };
  }

  const SOLO_CALLS = JSON.stringify([
    { tool: "memo.list", args: {} }, { tool: "channel.list", args: {} },
    { tool: "channel.notify", args: { member: "Sam", text: "No memos" } }, { tool: "done", summary: "Told Sam" },
  ]);

  it("email chosen during the install is connected, and the gateway reads it (D134)", async () => {
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const env = { ...keychain, ...TEST_TLS_ENV, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: SOLO_CALLS, INSTALLER_KEYCHAIN_DIR: keychain.INSTALLER_KEYCHAIN_DIR };
    const script = {
      answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "telegram", "services.email": "email", "services.slack": "none", "services.whatsapp": "none" },
      perform: { ...lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }), ...(await emailSteps(keychain, env)) },
    };
    const home = await makeTempHome();
    installs.push({ home, env });
    const run = await operate({ home, solutionRef: `file:${await pinnedStarter()}`, script, startArgs: [], env });
    expect(run.final.status).toBe("complete");
    expect(await loadChannel(home, "email")).toMatchObject({ channel: "email", address: MAIL_USER });
    expect(await getSecret("email-settings", keychain)).toBeNull();
    expect(runCli(["report"], { home, env }).stdout).not.toContain("taskfollow add email");
  });

  it("email added after the install with 'taskfollow add' shows only its steps and ends complete again (D134)", async () => {
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const env = { ...keychain, ...TEST_TLS_ENV, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: SOLO_CALLS };
    const solutionRef = `file:${await pinnedStarter()}`;
    const home = await makeTempHome();
    installs.push({ home, env });
    const first = await operate({
      home, solutionRef, startArgs: [], env,
      script: { answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "telegram", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" }, perform: lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }) },
    });
    expect(first.final.status).toBe("complete");
    expect(runCli(["report"], { home, env }).stdout).toContain("taskfollow add email");
    expect(await loadChannel(home, "email")).toBeNull();

    const added = runCli(["add", "email"], { home, env });
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ status: "step", view: { step: { step_id: "channels.email-key" } } });
    expect(runCli(["add", "email"], { home, env }).stderr).toContain("already part of this setup");
    expect(runCli(["add", "outlook"], { home, env }).stderr).toContain("You can add");

    const second = await operate({ home, solutionRef, startArgs: [], env, script: { answers: {}, perform: await emailSteps(keychain, env) } });
    expect(second.final.status).toBe("complete");
    expect(await loadChannel(home, "email")).toMatchObject({ channel: "email" });
    expect(runCli(["report"], { home, env }).stdout).not.toContain("taskfollow add email");
  });

  it("WhatsApp added after the install is connected, and a customer's message then reaches the inbox (D149)", async () => {
    const wa = await startFakeWhatsApp();
    servers.push(wa);
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const env = { ...keychain, ...wa.env, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: SOLO_CALLS };
    const solutionRef = `file:${await pinnedStarter()}`;
    const home = await makeTempHome();
    installs.push({ home, env });
    const first = await operate({
      home, solutionRef, startArgs: [], env,
      script: { answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "telegram", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" }, perform: lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }) },
    });
    expect(first.final.status).toBe("complete");
    expect(runCli(["report"], { home, env }).stdout).toContain("taskfollow add whatsapp");
    expect(runCli(["add", "whatsapp"], { home, env }).json).toMatchObject({ status: "step", view: { step: { step_id: "channels.whatsapp-key" } } });
    const second = await operate({
      home, solutionRef, startArgs: [], env,
      script: {
        answers: {},
        perform: {
          "channels.whatsapp-key": async (): Promise<void> => {
            await setSecret("whatsapp", JSON.stringify({ access_token: WA.token, app_secret: WA.secret, pull_token: WA.pull, verify_token: WA.verify, path_key: WA.path_key }), keychain);
            await setSecret("whatsapp-settings", JSON.stringify({ relay_url: "https://taskfollow-whatsapp.sam.workers.dev", phone_number_id: WA.phone_id, display_number: "+1 555 0100" }), keychain);
          },
          "channels.whatsapp": async (home2: string): Promise<void> => {
            const result = runCli(["channel", "whatsapp"], { home: home2, env });
            if (result.code !== 0) throw new Error(`taskfollow channel whatsapp failed: ${result.stderr}`);
          },
        },
      },
    });
    expect(second.final.status).toBe("complete");
    expect(await loadChannel(home, "whatsapp")).toMatchObject({ channel: "whatsapp", phone_number_id: WA.phone_id, display_number: "+1 555 0100" });
    await wa.deliver(textPayload({ id: "wamid.e2e", text: "Is my order on its way?" }));
    const end = Date.now() + 30_000;
    let found = false;
    while (!found && Date.now() < end) {
      found = (await listInbox(home)).some((item) => item.channel === "whatsapp" && item.text === "Is my order on its way?");
      if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(found).toBe(true);
  });

  it("Slack added after the install is connected, and the gateway then holds a live connection to it (D135)", async () => {
    const slack = await startFakeSlack();
    servers.push(slack);
    const keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    const env = { ...keychain, ...slack.env, FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: SOLO_CALLS };
    const solutionRef = `file:${await pinnedStarter()}`;
    const home = await makeTempHome();
    installs.push({ home, env });
    const first = await operate({
      home, solutionRef, startArgs: [], env,
      script: { answers: { "mode.purpose": "install", "mode.who": "me", "mode.name": "Sam", "mode.always-on": "no", "services.records": "none", "services.telegram": "telegram", "services.email": "none", "services.slack": "none", "services.whatsapp": "none" }, perform: lifecycleSteps(keychain, env, { workflow: "weekly-note", owner: "Sam" }) },
    });
    expect(first.final.status).toBe("complete");
    expect(runCli(["report"], { home, env }).stdout).toContain("taskfollow add slack");

    const added = runCli(["add", "slack"], { home, env });
    expect(added.json).toMatchObject({ status: "step", view: { step: { step_id: "channels.slack-key" } } });

    const settings = JSON.stringify({ team_id: SLACK_IDS.team_id, team: SLACK_IDS.team, bot_user_id: SLACK_IDS.bot_user_id, app_id: SLACK_IDS.app_id });
    const second = await operate({
      home, solutionRef, startArgs: [], env,
      script: {
        answers: {},
        perform: {
          "channels.slack-key": async (): Promise<void> => {
            await setSecret("slack", JSON.stringify({ bot: SLACK_BOT_TOKEN, app: APP_TOKEN }), keychain);
            await setSecret("slack-settings", settings, keychain);
          },
          "channels.slack": async (home2: string): Promise<void> => {
            const result = runCli(["channel", "slack"], { home: home2, env });
            if (result.code !== 0) throw new Error(`taskfollow channel slack failed: ${result.stderr}`);
          },
        },
      },
    });
    expect(second.final.status).toBe("complete");
    expect(await loadChannel(home, "slack")).toMatchObject({ channel: "slack", team_id: SLACK_IDS.team_id, app_id: SLACK_IDS.app_id });
    expect(await getSecret("slack-settings", keychain)).toBeNull();
    const end = Date.now() + 15_000;
    while ((await slack.stats()).live < 1 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await slack.stats()).live).toBeGreaterThanOrEqual(1);
    expect(runCli(["report"], { home, env }).stdout).not.toContain("taskfollow add slack");
  });

  it("ends READY at level 3 with Skills Wiki registered in the agent; disconnect then removes it all", async () => {
    const { fake, env, keychain, script, registration } = await setup();
    const home = await makeTempHome();
    installs.push({ home, env });
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect(await loadState(home)).toMatchObject({
      mode: "team_host", roles: { decision_maker: "Owner" }, skillswiki: { url: fake.url },
      runtime: { profile: "fake-agent", c6_mcp: true, support_level: 3, notes: [] },
    });
    const report = runCli(["report"], { home, env }).stdout;
    expect(report).toContain("✅ READY  (26 of 26 steps done) · fixture-starter@1.0.0");
    expect(runCli(["sandbox"], { home, env }).json).toEqual({ mode: expect.objectContaining({ on: false, by: "engine" }), workflows: [{ workflow: "contacts-summary", sandbox: false }] });
    expect(runCli(["gateway", "status"], { home, env }).json).toMatchObject({ status: "running" });
    expect(runCli(["sandbox", "outbox"], { home, env }).json).toMatchObject({ outbox: expect.arrayContaining([expect.objectContaining({ to: "1002", text: "0 contacts", run: expect.stringMatching(/^contacts-summary\//) })]) });
    expect(report).toContain("🤖 Agent      fake-agent 9.9.9 — level 3 of 3");
    expect(JSON.parse(await readFile(registration, "utf8"))).toMatchObject({ type: "http", url: fake.url, headersHelper: expect.stringMatching(/mcp-headers skillswiki$/) });
    const tools = JSON.parse(await readFile(join(dirname(registration), "installer.json"), "utf8"));
    expect(tools).toEqual({ type: "stdio", command: process.execPath, args: [installerCliPath(), "--home", home, "mcp-serve"] });

    const gone = runCli(["disconnect", "skillswiki"], { home, env });
    expect(gone.json).toEqual({ status: "disconnected", unregistered: true, secret_deleted: true });
    await expect(access(registration)).rejects.toThrow();
    await expect(getSecret("skillswiki", keychain)).resolves.toBeNull();
    const lastAudit = (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(lastAudit)).toMatchObject({ event: "secret.disconnected", ref: "skillswiki", actor: "human" });
    await expect(verifyAudit(home, (await loadState(home))?.audit_head)).resolves.toMatchObject({ ok: true });
    expect(runCli(["disconnect", "skillswiki"], { home, env }).json).toEqual({ status: "disconnected", unregistered: false, secret_deleted: false });
    expect(runCli(["tool", "records.find", '{"entity":"contact"}'], { home, env }).json).toEqual({ entity: "contact", records: [], total: 0 });
    expect(runCli(["disconnect", "google-sheets"], { home, env }).json).toMatchObject({ status: "disconnected", connector: "google-sheets", secret_deleted: true });
    await expect(getSecret("google", keychain)).resolves.toBeNull();
    expect(runCli(["tool", "records.find", '{"entity":"contact"}'], { home, env }).json).toMatchObject({ code: 2, error: expect.stringContaining("run 'taskfollow secret google'") });
    await expect(verifyAudit(home, (await loadState(home))?.audit_head)).resolves.toMatchObject({ ok: true });
  });

  it("without workspace trust ends READY WITH LIMITS and names the folder (D52, Review Focus 2)", async () => {
    const { fake, env, script } = await setup({ FAKE_AGENT_DROP: "trust" });
    const home = await makeTempHome();
    installs.push({ home, env });
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect((await loadState(home))?.runtime).toMatchObject({ c6_mcp: false, support_level: 2, notes: [expect.stringContaining("workspace trust may be missing in ")] });
    expect(runCli(["report"], { home, env }).stdout).toContain("⚠️ READY WITH LIMITS  (26 of 26 steps done)");
    expect(runCli(["report"], { home, env }).stdout).toContain("level 2 of 3 (no MCP client; Skills Wiki content is inlined)");
  });

  it("blocks at the key step, naming the secret command, when the person never enters the key", async () => {
    const { fake, env, script } = await setup();
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script: { ...script, giveUp: ["brain.key"] }, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("blocked");
    expect(runCli(["report", "--json"], { home, env }).json).toMatchObject({ overall: "blocked", needs_you: [{ step_id: "brain.key", detail: expect.stringContaining("run 'taskfollow secret skillswiki'") }] });
  });
});
