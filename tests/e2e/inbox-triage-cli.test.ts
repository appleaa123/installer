import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { loadStep, listRuns } from "../../src/core/runs.js";
import { loadState, saveState } from "../../src/core/state.js";
import { runCli } from "../helpers/cli.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 5 through the real CLI: the starter's inbox-triage suggestion added, dry-run, and run again on new mail only. */
const AT = "2026-10-16T12:00:00.000Z";
const STARTER = JSON.parse(readFileSync("solutions/starter.json", "utf8")) as { workflows: Record<string, unknown>[] };
const { when: _when, ...TRIAGE } = STARTER.workflows.find((flow) => flow.workflow === "inbox-triage") ?? {};
const SOLUTION = { id: "fixture-runner", version: "1.0.0", workflows: [TRIAGE], steps: [{ step_id: "report.final", phase: "REPORT", type: "auto", title: "Finish", why: "Finishes.", blocking: true, auto: { action: "noop" } }] };
const LIST = JSON.stringify([{ tool: "done", summary: "1 message needs you." }]);

async function mail(home: string, n: number, text: string): Promise<void> {
  await storeInbound(home, normalizeInbound({ channel: "email", from: `tenant${n}@example.com`, thread: `<m${n}@x>`, text, message_id: `<m${n}@x>` }, AT), "event");
}
const readOf = async (home: string, runId: string): Promise<string[]> => {
  const run = (await listRuns(home, "inbox-triage")).find((candidate) => candidate.run_id === runId);
  if (!run) throw new Error(`no run ${runId}`);
  return ((await loadStep(home, run, "mail"))?.output as { messages: { text: string }[] }).messages.map((message) => message.text);
};

describe("inbox triage through the CLI (item 5)", () => {
  it("the starter's inbox-triage suggestion is added, inbox-triage and runs it once in sandbox; the next run lists only new mail", async () => {
    const home = await runnerHome();
    const work = await mkdtemp(join(tmpdir(), "install-folder-"));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    await writePinnedSolution(home, JSON.stringify(SOLUTION));
    expect(runCli(["workflow", "suggestions"], { home }).json).toMatchObject({ suggestions: [expect.objectContaining({ workflow: "inbox-triage" })] });
    expect(runCli(["workflow", "add", "inbox-triage", "--value", JSON.stringify({ trigger: { manual: true } })], { home })).toMatchObject({ code: 0, json: { status: "added", skill_folder: join(work, ".claude", "skills", "inbox-triage") } });
    await mail(home, 1, "The heating is broken.");
    const env = { FAKE_AGENT_HOME: await makeTempHome(), FAKE_AGENT_JUDGE: LIST };
    const dry = runCli(["dryrun", "inbox-triage"], { home, env });
    expect(dry).toMatchObject({ code: 0, json: { dry_runs: [{ status: "completed" }] } });
    const dryId = (dry.json as { dry_runs: { run_id: string }[] }).dry_runs[0]?.run_id ?? "";
    expect(await readOf(home, dryId)).toEqual(["The heating is broken."]);
    await mail(home, 2, "Can I have the lease copy?");
    const next = runCli(["run", "inbox-triage", "--sandbox"], { home, env: { ...env, FAKE_AGENT_HOME: await makeTempHome() } });
    expect(next).toMatchObject({ code: 0, json: { status: "completed" } });
    expect(await readOf(home, (next.json as { run_id: string }).run_id)).toEqual(["Can I have the lease copy?"]);
  });
});
