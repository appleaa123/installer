import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";

const NOTE = { workflow: "note", version: 1, description: "Adds one memo", steps: [{ id: "add", tool: "memo.add", args: { text: "Run ${run.id}" } }] };

/** A finished install of the one-step channels fixture, with one manual workflow. */
async function home(): Promise<string> {
  const dir = await makeTempHome();
  const started = runCli(["start", "--solution", "file:tests/fixtures/solution-channels.json"], { home: dir });
  if (started.code !== 0) throw new Error(started.stderr);
  await writeWorkflow(dir, NOTE);
  return dir;
}

describe("taskpilot run, tick, schedule and model (§6.6, D82)", () => {
  it("runs a workflow now and prints the run", async () => {
    const dir = await home();
    const result = runCli(["run", "note"], { home: dir });
    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ workflow: "note", status: "completed", sandbox: false, actions: 1, steps: [{ step: "add", status: "done" }], log: expect.stringMatching(/^runs\/note\/\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/) });
    expect(runCli(["run", "note", "--sandbox"], { home: dir }).json).toMatchObject({ status: "completed", sandbox: true });
    expect((await readdir(join(dir, "runs", "note")))).toHaveLength(2);
  });

  it("names the workflows when none or an unknown one is given (exit 2)", async () => {
    const dir = await home();
    expect(runCli(["run"], { home: dir }).json).toEqual({ error: "run needs a workflow: note", code: 2 });
    expect(runCli(["run", "other"], { home: dir }).json).toMatchObject({ error: expect.stringContaining("No workflow 'other'"), code: 2 });
  });

  it("tick prints what it did, and schedule list shows the last tick", async () => {
    const dir = await home();
    expect(runCli(["tick"], { home: dir }).json).toMatchObject({ status: "ran", started: [], missed: [], errors: [] });
    expect(runCli(["schedule", "list"], { home: dir }).json).toMatchObject({ workflows: [{ workflow: "note", trigger: { kind: "manual" }, next: null }], last_tick: expect.any(String) });
  });

  it("schedule install writes the entry in the home and prints the commands for the person", async () => {
    const dir = await home();
    const result = runCli(["schedule", "install"], { home: dir });
    const backend = process.platform === "darwin" ? "launchd" : "crontab";
    expect(result.json).toMatchObject({ backend, commands: expect.arrayContaining([expect.stringContaining(backend === "launchd" ? "launchctl bootstrap" : "crontab -")]) });
    const text = await readFile(String((result.json as { file: string }).file), "utf8");
    expect(text).toContain(`${dir}`);
    expect(text).toContain("tick");
  });

  it("schedule report saves its settings; model refuses an agent's shell (no terminal)", async () => {
    const dir = await home();
    expect(runCli(["schedule", "report", "--value", '{"recipients":[{"member":"Owner","tz":"America/Toronto"}]}'], { home: dir }).json).toMatchObject({ status: "saved" });
    const refused = runCli(["model", "--value", '{"provider":"anthropic","model":"test-model"}'], { home: dir });
    expect(refused.code).toBe(2);
    expect(refused.json).toMatchObject({ error: expect.stringContaining("not by the agent") });
    expect(runCli(["model"], { home: dir }).json).toMatchObject({ model: null });
  });
});
