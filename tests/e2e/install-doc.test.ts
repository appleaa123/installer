import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { usesSkillswiki } from "../../src/core/skillswiki.js";
import { installerCliPath } from "../../src/core/register.js";
import { parseSolution } from "../../src/core/solution.js";
import { loadState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { STARTER_REF, operate, starterScript } from "../operator/scripted-operator.js";

const DOC = readFileSync("INSTALL.md", "utf8");
const COMMANDS = ["start", "next", "submit", "verify", "resume", "report", "probe", "secret", "disconnect", "tool", "approvals", "connect", "map", "channel", "invite", "members", "gateway", "run", "schedule", "model"];

describe("INSTALL.md", () => {
  it("states the five operator rules from spec §6.1", () => {
    for (const rule of ["1. Never invent an answer", "2. Always tell the person why", "3. Never request, repeat or store secrets", "4. At a blocking human step, stop", "5. After every `agent_action`, run the step's verify", "6. Never approve, edit or reject an approval yourself"]) {
      expect(DOC).toContain(rule);
    }
  });

  it("has the three placeholders the solution server fills in, with the key stored before start (D46)", () => {
    expect(DOC).toContain("{{INSTALL_COMMAND}}");
    expect(DOC).toContain("installer start --solution {{SOLUTION_REF}} --url {{SKILLSWIKI_URL}}");
    expect(DOC.indexOf("installer secret skillswiki")).toBeLessThan(DOC.indexOf("installer start --solution"));
  });

  it("only names commands the CLI has", () => {
    const named = [...DOC.matchAll(/(?:^|`)installer ([\w-]+)/gm)].map((match) => match[1]);
    expect(named.filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("the shipped starter solution loads, probes with the bundled profiles and connects Skills Wiki", () => {
    const starter = parseSolution(JSON.parse(readFileSync("solutions/starter.json", "utf8")));
    expect(starter.steps[0]?.auto).toEqual({ action: "probe_runtime", args: {} });
    expect(starter.steps.map((step) => step.step_id)).toEqual(expect.arrayContaining(["preflight.tools", "brain.key", "brain.register", "brain.combo", "brain.probe-mcp", "data.google", "data.connect", "data.map"]));
    expect(Object.keys(starter.data_contract?.entities.contact?.fields ?? {})).toEqual(["name", "email", "notes"]);
    expect(usesSkillswiki(starter)).toBe(true);
  });
});

describe("starter install, operated the way INSTALL.md says", () => {
  const servers: (FakeMcp | FakeGoogle)[] = [];

  afterEach(() => {
    servers.splice(0).forEach((fake) => fake.stop());
  });

  /** The agent's DATA actions as INSTALL.md section 6 says: the person signs in, the agent connects a new sheet and maps it. */
  function dataSteps(keychain: Record<string, string>, env: Record<string, string>) {
    const ok = (args: string[]) => async (home: string): Promise<void> => {
      const result = runCli(args, { home, env });
      if (result.code !== 0) throw new Error(`installer ${args.join(" ")} failed: ${result.stderr}`);
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
    const env = { ...keychain, ...google.env, FAKE_AGENT_HOME: agentHome, ...extraEnv };
    const script = starterScript(() => setSecret("skillswiki", fake.key, keychain), dataSteps(keychain, env));
    return { fake, env, keychain, script, registration: join(agentHome, "mcp", "skillswiki.json") };
  }

  it("ends READY at level 3 with Skills Wiki registered in the agent; disconnect then removes it all", async () => {
    const { fake, env, keychain, script, registration } = await setup();
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect(await loadState(home)).toMatchObject({
      mode: "team_host", roles: { decision_maker: "Owner" }, skillswiki: { url: fake.url },
      runtime: { profile: "fake-agent", c6_mcp: true, support_level: 3, notes: [] },
    });
    const report = runCli(["report"], { home, env }).stdout;
    expect(report).toContain("✅ READY  (14 of 14 steps done) · fixture-starter@1.0.0");
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
    expect(runCli(["tool", "records.find", '{"entity":"contact"}'], { home, env }).json).toMatchObject({ code: 2, error: expect.stringContaining("run 'installer secret google'") });
    await expect(verifyAudit(home, (await loadState(home))?.audit_head)).resolves.toMatchObject({ ok: true });
  });

  it("without workspace trust ends READY WITH LIMITS and names the folder (D52, Review Focus 2)", async () => {
    const { fake, env, script } = await setup({ FAKE_AGENT_DROP: "trust" });
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("complete");
    expect((await loadState(home))?.runtime).toMatchObject({ c6_mcp: false, support_level: 2, notes: [expect.stringContaining("workspace trust may be missing in ")] });
    expect(runCli(["report"], { home, env }).stdout).toContain("⚠️ READY WITH LIMITS  (14 of 14 steps done)");
    expect(runCli(["report"], { home, env }).stdout).toContain("level 2 of 3 (no MCP client; Skills Wiki content is inlined)");
  });

  it("blocks at the key step, naming the secret command, when the person never enters the key", async () => {
    const { fake, env, script } = await setup();
    const home = await makeTempHome();
    const run = await operate({ home, solutionRef: STARTER_REF, script: { ...script, giveUp: ["brain.key"] }, startArgs: ["--url", fake.url], env });
    expect(run.final.status).toBe("blocked");
    expect(runCli(["report", "--json"], { home, env }).json).toMatchObject({ overall: "blocked", needs_you: [{ step_id: "brain.key", detail: expect.stringContaining("run 'installer secret skillswiki'") }] });
  });
});
