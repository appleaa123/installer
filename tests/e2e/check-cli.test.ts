import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startChallenge } from "../../src/core/checks.js";
import { runCli } from "../helpers/cli.js";
import { runnerHome } from "../helpers/runner-home.js";

const URL_LIKE = /127\.0\.0\.1:\d+|\/check\/[0-9a-f]{32}/;

async function hostileEnv(): Promise<{ env: Record<string, string>; log: string }> {
  const bin = await mkdtemp(join(tmpdir(), "fake-open-"));
  const log = join(bin, "opened.log");
  for (const name of ["open", "xdg-open"]) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "$@" >> ${log}\n`);
    await chmod(join(bin, name), 0o755);
  }
  return { env: { PATH: `${bin}:${process.env.PATH ?? ""}`, INSTALLER_BROWSER: "none", SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, log };
}

describe("taskfollow check through the CLI (Review Focus 1)", () => {
  it("starts, answers and lists a check, with no page address in any output", async () => {
    const home = await runnerHome();
    const { env, log } = await hostileEnv();
    const started = runCli(["check", "start", "t1"], { home, env });
    expect(started.code).toBe(0);
    expect(`${started.stdout}${started.stderr}`).not.toMatch(URL_LIKE);
    const { id, instruction } = started.json as { id: string; instruction: string };
    const marked = runCli(["check", "mark", id, instruction.split(" ").at(-1) ?? ""], { home, env });
    expect(marked.json).toMatchObject({ need: "answers", result: "yes, tested" });
    expect(runCli(["check", "list"], { home, env }).json).toMatchObject({ results: [expect.objectContaining({ result: "yes, tested" })] });
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");
  });

  it("launches the person's page with no address in any output, file or opener log, under a hostile environment", async () => {
    const home = await runnerHome();
    const { writeWorkflow } = await import("../helpers/workflow-home.js");
    await writeWorkflow(home, { workflow: "count", version: 1, mode: "agentic", description: "Count my memos.", instructions: "x", tools: ["memo.list"] });
    const { env, log } = await hostileEnv();
    const started = runCli(["check", "start", "describe", "--workflow", "count"], { home, env });
    try {
      expect(started.code).toBe(0);
      expect(`${started.stdout}${started.stderr}`).not.toMatch(URL_LIKE);
      expect(started.json).toMatchObject({ page: expect.stringContaining("taskfollow check page") });
      let files = "";
      try {
        files = execFileSync("/usr/bin/grep", ["-rlE", "127\\.0\\.0\\.1:[0-9]+", home], { encoding: "utf8" }).trim();
      } catch {
        files = "";
      }
      expect(files).toBe("");
      expect(await readFile(log, "utf8").catch(() => "")).toBe("");
    } finally {
      const id = (started.json as { id?: string }).id ?? "none";
      try {
        execFileSync("/usr/bin/pkill", ["-f", `check-serve ${id}`]);
      } catch {
        // already gone
      }
    }
  });

  it("refuses check-serve without the command that starts it, and prints no address", async () => {
    const home = await runnerHome();
    const { challenge } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, new Date().toISOString());
    const served = runCli(["check-serve", challenge.id], { home });
    expect(served.code).toBe(2);
    expect(`${served.stdout}${served.stderr}`).not.toMatch(URL_LIKE);
  });

  it("refuses the confirmation page from an agent's shell", async () => {
    const home = await runnerHome();
    const { challenge } = await startChallenge(home, { needs: ["scheduler"], test: "t8", agent: "a", agentVersion: null, ttlMs: 60_000 }, new Date().toISOString());
    const page = runCli(["check", "page", challenge.id], { home });
    expect(page).toMatchObject({ code: 2, json: { error: expect.stringContaining("in your own terminal") } });
  });
});
