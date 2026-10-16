import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requestApproval } from "../../src/core/approvals.js";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, prepareAction, requireTool, toolContext } from "../../src/core/tools.js";
import { RUNS_DIR, claimRun, fingerprint, listRuns, loadRun, loadStep, newestStepOutput, recordMissed, runForKey, runIdFor, saveStep, type RunRecord } from "../../src/core/runs.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const record = (key: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  workflow: "memo-digest", run_id: runIdFor(key, AT), key, trigger: { kind: "cron", scheduled_for: AT }, version: 1, status: "running",
  started_at: AT, sandbox: false, pid: process.pid, actions: 0, needs_human: 0, ...extra,
});
const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("the run log (§10.6, D86)", () => {
  it("names a run by its date and its key", () => {
    expect(runIdFor("memo-digest:2026-10-08T12:00:00.000Z", AT)).toMatch(/^2026-10-08-[0-9a-f]{8}$/);
    expect(runIdFor("a", AT)).not.toBe(runIdFor("b", AT));
    expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
  });

  it("claims a key once: a second claim of the same key is refused, even with another record", async () => {
    const home = await makeTempHome();
    const first = record("memo-digest:2026-10-08T12:00:00.000Z");
    expect(await claimRun(home, first)).toBe(true);
    expect(await claimRun(home, { ...first, run_id: "2026-10-08-other" })).toBe(false);
    expect(await runForKey(home, first.key)).toEqual(first);
    expect(await runForKey(home, "memo-digest:never")).toBeNull();
    expect((await stat(join(home, RUNS_DIR, "memo-digest", first.run_id, "run.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps each step's log and lists runs oldest first", async () => {
    const home = await makeTempHome();
    const late = record("k2", { trigger: { kind: "manual" }, started_at: "2026-10-08T13:00:00.000Z" });
    const early = record("k1");
    await claimRun(home, late);
    await claimRun(home, early);
    await saveStep(home, early, { step: "memos", status: "done", started_at: AT, finished_at: AT, duration_ms: 3, input_fingerprint: fingerprint({}), output: { memos: [] } });
    expect(await loadStep(home, early, "memos")).toMatchObject({ status: "done", output: { memos: [] } });
    expect(await loadStep(home, early, "other")).toBeNull();
    expect((await listRuns(home)).map((run) => run.key)).toEqual(["k1", "k2"]);
    expect(await loadRun(home, "memo-digest", "nothing")).toBeNull();
  });

  it("records a missed run once, audited, and never as a run to do (D38)", async () => {
    const home = await makeTempHome();
    const missed = await recordMissed(home, "memo-digest", 1, "memo-digest:2026-10-08T12:00:00.000Z", AT, "2026-10-08T12:30:00.000Z");
    expect(missed).toMatchObject({ status: "missed", trigger: { kind: "cron", scheduled_for: AT }, finished_at: "2026-10-08T12:30:00.000Z" });
    expect(await recordMissed(home, "memo-digest", 1, "memo-digest:2026-10-08T12:00:00.000Z", AT, "2026-10-08T12:31:00.000Z")).toBeNull();
    expect(await events(home)).toEqual(["run.missed"]);
  });
});

describe("an approval a workflow asks for (D87)", () => {
  it("names its run and step in the item's source", async () => {
    const home = await makeTempHome();
    const ctx = await toolContext(home, "runner", DEFAULT_TOOLS, () => AT);
    await invokeTool(ctx, "memo.add", { text: "first" });
    const edit = await prepareAction(ctx, requireTool(DEFAULT_TOOLS, "memo.edit"), { id: 1, text: "second" });
    const item = await requestApproval(home, { prepared: edit, why: "The digest says so", via: "runner", run: { workflow: "memo-digest", run_id: "2026-10-08-1a2b3c4d", step: "fix" } }, AT);
    expect(item.source).toEqual({ via: "runner", run: { workflow: "memo-digest", run_id: "2026-10-08-1a2b3c4d", step: "fix" } });
  });
});

describe("newestStepOutput: where the inbox triage starts reading (item 5)", () => {
  const at = (hour: number) => `2026-10-08T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const mailOut = (newest: number) => ({ messages: [], newest_id: newest });
  /** A run of `memo-digest` at `hour`, with its mail and triage steps as given (undefined: the step never ran). */
  async function past(home: string, hour: number, mail: number | undefined, triage: unknown, extra: Partial<RunRecord> = {}): Promise<RunRecord> {
    const run = record(`k${hour}${extra.sandbox ? "s" : ""}`, { started_at: at(hour), status: "completed", ...extra });
    await claimRun(home, run);
    if (mail !== undefined) await saveStep(home, run, { step: "mail", status: "done", started_at: at(hour), finished_at: at(hour), duration_ms: 0, input_fingerprint: fingerprint(null), output: mailOut(mail) });
    if (triage !== undefined) await saveStep(home, run, { step: "triage", status: "done", started_at: at(hour), finished_at: at(hour), duration_ms: 0, input_fingerprint: fingerprint(null), output: triage });
    return run;
  }
  const now = (hour: number, extra: Partial<RunRecord> = {}) => record(`now${hour}`, { started_at: at(hour), ...extra });

  it("takes the newest earlier run whose list was made, whatever its status", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    await past(home, 9, 7, { summary: "4 messages", calls: 1 }, { status: "waiting" });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(7));
  });

  it("a run whose triage ended with needs and no summary lists its mail again", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    await past(home, 9, 7, null, { status: "partial" });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(3));
  });

  it("a run paused between mail and triage lists its mail again", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    await past(home, 9, 7, undefined, { status: "partial" });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(3));
  });

  it("sandbox and live watermarks are kept separate", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "live", calls: 1 });
    await past(home, 9, 7, { summary: "dry", calls: 1 }, { sandbox: true });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(3));
    expect(await newestStepOutput(home, now(10, { sandbox: true }), "mail", "triage")).toEqual(mailOut(7));
  });

  it("an empty summary does not move the watermark (PR #59 review)", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    await past(home, 9, 7, { summary: "   ", calls: 0 });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(3));
  });

  it("falls back to an older run when the read step has no usable output (PR #59 review)", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    const skipped = await past(home, 9, undefined, { summary: "list", calls: 1 });
    await saveStep(home, skipped, { step: "mail", status: "done", started_at: at(9), finished_at: at(9), duration_ms: 0, input_fingerprint: fingerprint(null), output: null, skipped: true });
    const usable = (output: unknown) => typeof (output as { newest_id?: unknown } | null)?.newest_id === "number";
    expect(await newestStepOutput(home, now(10), "mail", "triage", usable)).toEqual(mailOut(3));
  });

  it("skips a damaged run, and lets any other error through (PR #59 review)", async () => {
    const home = await makeTempHome();
    await past(home, 8, 3, { summary: "3 messages", calls: 1 });
    const damaged = await past(home, 9, 7, { summary: "list", calls: 1 });
    const { writeFile, chmod } = await import("node:fs/promises");
    const file = join(home, RUNS_DIR, "memo-digest", damaged.run_id, "steps", "mail.json");
    await writeFile(file, JSON.stringify({ step: "mail", status: "strange" }));
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toEqual(mailOut(3));
    await chmod(file, 0o000);
    await expect(newestStepOutput(home, now(10), "mail", "triage")).rejects.toThrow();
    await chmod(file, 0o600);
  });

  it("is null on the first run, and ignores later runs and the run itself", async () => {
    const home = await makeTempHome();
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toBeNull();
    await past(home, 11, 9, { summary: "later", calls: 1 });
    expect(await newestStepOutput(home, now(10), "mail", "triage")).toBeNull();
  });
});
