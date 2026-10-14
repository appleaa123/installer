import { guideCommand } from "../../src/core/guide-commands.js";
import { readFileSync } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { saveChannel } from "../../src/core/channels.js";
import { dryrunCommand } from "../../src/core/lifecycle.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { usesSkillswiki } from "../../src/core/skillswiki.js";
import { installerCliPath } from "../../src/core/register.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { BOT_TOKEN } from "../helpers/fake-telegram.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, operate, starterScript } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe", "secret", "guide", "disconnect", "tool", "approvals", "connect", "map", "channel", "invite", "members", "gateway", "run", "schedule", "model", "workflow", "dryrun", "sandbox", "harden", "autonomy", "alerts", "learnings", "doctor", "pause", "unpause", "host", "packs", "retention", "support", "uninstall"];

describe("INSTALL.md", () => {
  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify", "6. Never approve, edit or reject an approval yourself"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("has the placeholders the solution server fills in; the base start needs no Skills Wiki URL (D126)", () => {
    expect(DOC).toContain("{{INSTALL_COMMAND}}");
    expect(DOC).toContain("taskfollow start --solution {{SOLUTION_REF}}\n");
    expect(DOC).toContain("--url {{SKILLSWIKI_URL}}");
    const optional = DOC.indexOf("## 11.");
    expect(optional).toBeGreaterThan(0);
    expect(DOC.indexOf("taskfollow secret skillswiki")).toBeGreaterThan(optional);
    expect(DOC.indexOf("taskfollow secret skillswiki")).toBeLessThan(DOC.indexOf("--url {{SKILLSWIKI_URL}}"));
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
    expect(starter.workflows?.map((workflow) => workflow.workflow)).toEqual(["contacts-summary"]);
    expect(Object.keys(starter.data_contract?.entities.contact?.fields ?? {})).toEqual(["name", "email", "notes"]);
    expect(usesSkillswiki(starter)).toBe(false);
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

describe("starter install, operated the way INSTALL.md says", () => {
  const servers: (FakeMcp | FakeGoogle)[] = [];
  const installs: { home: string; env: Record<string, string> }[] = [];

  afterEach(() => {
    installs.splice(0).forEach(({ home, env }) => runCli(["gateway", "stop"], { home, env }));
    servers.splice(0).forEach((fake) => fake.stop());
  });

  /**
   * CHANNELS to ACTIVATE (D98): the person stores the bot token, the channel is checked (written directly here: the
   * one test connector server is the fake Google), the decision maker joins, a suggested workflow is added, dry-run
   * and confirmed in the person's terminal, and the OS scheduler's first tick is simulated with 'taskfollow tick'.
   */
  function lifecycleSteps(keychain: Record<string, string>, env: Record<string, string>) {
    const cli = (args: string[]) => async (home: string): Promise<void> => {
      const result = runCli(args, { home, env });
      if (result.code !== 0) throw new Error(`taskfollow ${args.join(" ")} failed: ${result.stderr}`);
    };
    const now = (): string => new Date().toISOString();
    return {
      "channels.telegram-key": () => setSecret("telegram", BOT_TOKEN, keychain),
      "channels.telegram": (home: string) => saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: now() }),
      "channels.join": async (home: string) => {
        const { code } = await createInvite(home, "Owner", { decision_maker: "Owner" }, now());
        await joinWithCode(home, code, { channel: "telegram", address: "1002" }, now());
      },
      "workflows.choose": cli(["workflow", "add", "contacts-summary"]),
      "dryrun.run": cli(["dryrun"]),
      "dryrun.confirm": async (home: string) => void (await dryrunCommand(home, "confirm", "contacts-summary", { interactive: true, as: "Owner" }, now)),
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
      answers: { "mode.shared-work": "yes", "mode.always-on": "no", "mode.decision-maker": "Owner" },
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
