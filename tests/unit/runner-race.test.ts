import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { createExclusive } from "../../src/core/durable.js";
import { startRun } from "../../src/core/runner.js";
import { KEYS_DIR, runIdFor, saveRun, type RunRecord } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { MEMO_DIGEST } from "../helpers/workflow-home.js";

/** The loser's first look at the key happens before the winner claims it: the first read of a key sees it free. */
vi.mock("../../src/core/runs.js", async (original) => {
  const real = await original<typeof import("../../src/core/runs.js")>();
  const looked = new Set<string>();
  return {
    ...real,
    runForKey: async (home: string, key: string) => {
      if (looked.has(`${home}|${key}`)) return real.runForKey(home, key);
      looked.add(`${home}|${key}`);
      return null;
    },
  };
});

const AT = "2026-10-08T12:00:00.000Z";
const KEY = `memo-digest:${AT}`;
const workflow = parseWorkflow({ ...MEMO_DIGEST, steps: [{ id: "note", tool: "memo.add", args: { text: "ran" } }] }, "memo-digest", DEFAULT_TOOLS);
const request = (home: string) => ({ home, workflow, key: KEY, trigger: { kind: "cron" as const, scheduled_for: AT }, now: () => AT });
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
const auditText = (home: string) => readFile(join(home, AUDIT_FILE), "utf8").catch(() => "");

/** What the winning process has written so far: its claim on the key, and maybe its run.json. */
async function winnerClaims(home: string): Promise<void> {
  const dir = join(home, KEYS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, createHash("sha256").update(KEY).digest("hex")), JSON.stringify({ workflow: "memo-digest", run_id: runIdFor(KEY, AT) }));
}

describe("a claim that loses the race (§10.7, D86)", () => {
  it("is busy, and starts nothing, when the winner has claimed the key but not written its run yet", async () => {
    const home = await runnerHome();
    await winnerClaims(home);
    await expect(startRun(request(home))).rejects.toThrow(/busy/);
    expect(await memos(home)).toEqual([]);
    expect(await auditText(home)).not.toContain('"event":"run.started"');
  });

  it("returns the winner's run as it is, never running it a second time", async () => {
    const home = await runnerHome();
    await winnerClaims(home);
    const winner: RunRecord = { workflow: "memo-digest", run_id: runIdFor(KEY, AT), key: KEY, trigger: { kind: "cron", scheduled_for: AT }, version: 1, status: "running", started_at: AT, sandbox: false, pid: process.pid, actions: 0, needs_human: 0 };
    await saveRun(home, winner);
    expect(await startRun(request(home))).toEqual(winner);
    expect(await memos(home)).toEqual([]);
  });
});

describe("createExclusive (a file that is never seen empty)", () => {
  it("creates the file with its content once, and leaves no temporary file", async () => {
    const dir = await makeTempHome();
    const path = join(dir, "claim");
    expect(await createExclusive(path, "first")).toBe(true);
    expect(await createExclusive(path, "second")).toBe(false);
    expect(await readFile(path, "utf8")).toBe("first");
    expect(await readdir(dir)).not.toContainEqual(expect.stringContaining(".tmp"));
  });
});
