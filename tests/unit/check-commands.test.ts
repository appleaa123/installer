import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { launchCheckPage } from "../../src/core/check-page.js";
import { checkCommand } from "../../src/core/check-commands.js";
import { abilities, startChallenge } from "../../src/core/checks.js";
import { loadState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { describeTools, invokeTool, toolContext } from "../../src/core/tools.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-16T12:00:00.000Z";
const ctx = (interactive = false) => ({ interactive, now: () => AT });
const run = async (home: string, args: string[], flags: Record<string, string> = {}, interactive = false) => checkCommand(home, (await loadState(home)) ?? undefined, args, flags, ctx(interactive));

describe("taskfollow check (D159)", () => {
  it("starts T1 with an instruction for the agent and no page", async () => {
    const home = await runnerHome();
    const out = await run(home, ["start", "t1"]);
    expect(out).toMatchObject({ id: expect.stringMatching(/^c[0-9a-f]{8}$/), test: "t1", instruction: expect.stringMatching(/^Run: taskfollow check mark c[0-9a-f]{8} [A-Z]+-[A-Z2-9]{4}$/) });
    expect(JSON.stringify(out)).not.toMatch(/127\.0\.0\.1|http:/);
  });

  it("records the agent named by the install's probe, or the home agent the person names", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t1"])) as { id: string; instruction: string };
    await run(home, ["mark", out.id, out.instruction.split(" ").at(-1) ?? ""]);
    expect(await abilities(home)).toEqual([expect.objectContaining({ need: "answers", result: "yes-tested", agent: "fake-agent", agent_version: "9.9.9" })]);
    const named = (await run(home, ["start", "t1"], { value: JSON.stringify({ agent: "Claude Cowork" }) })) as { id: string };
    expect(named.id).toBeTruthy();
  });

  it("answers T5 through check.ping and records the path it came by", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t5"])) as { id: string; instruction: string };
    const word = /word ([A-Z]+-[A-Z2-9]{4})/.exec(out.instruction)?.[1] ?? "";
    await invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS, () => AT), "check.ping", { id: out.id, word });
    expect(await abilities(home)).toEqual([expect.objectContaining({ need: "tools", result: "yes-tested", via: "mcp" })]);
  });

  it("lists check.ping over MCP as a tool that takes no approval token", () => {
    const ping = describeTools(DEFAULT_TOOLS).find((tool) => tool.name === "check.ping");
    expect(ping?.inputSchema).toMatchObject({ required: ["id", "word"] });
    expect(JSON.stringify(ping?.inputSchema)).not.toContain("approval_token");
  });

  it("opens the confirmation page only for a person at a terminal", async () => {
    const home = await runnerHome();
    const { challenge } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "a", agentVersion: null, ttlMs: 60_000 }, AT);
    await expect(run(home, ["page", challenge.id])).rejects.toThrow("in your own terminal");
  });

  it("lists results in plain words", async () => {
    const home = await runnerHome();
    const out = (await run(home, ["start", "t1"])) as { id: string; instruction: string };
    await run(home, ["mark", out.id, out.instruction.split(" ").at(-1) ?? ""]);
    expect(await run(home, ["list"])).toMatchObject({ results: [expect.objectContaining({ need: "answers", result: "yes, tested" })] });
  });
});

describe("the check page process (plan review 3)", () => {
  it("starts with the home, gets the word over IPC, and reports only its pid", async () => {
    const home = await runnerHome();
    const { challenge, word } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    const launched = await launchCheckPage(home, challenge.id, word, resolve("dist/cli.js"));
    try {
      expect(Object.keys(launched).sort()).toEqual(["opened", "pid"]);
      expect(launched.opened).toBe(false);
    } finally {
      process.kill(launched.pid);
    }
  });
});
