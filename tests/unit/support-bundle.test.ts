import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { saveSource, writeConfig } from "../../src/core/data-source.js";
import { DOCTOR_FILE } from "../../src/core/doctor.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { LOG_FILE } from "../../src/core/gateway.js";
import { storeInbound } from "../../src/core/inbox.js";
import { setSecret } from "../../src/core/keychain.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { saveRun } from "../../src/core/runs.js";
import { TICK_LOG } from "../../src/core/scheduler.js";
import { loadState, saveState } from "../../src/core/state.js";
import { scrub, supportBundle } from "../../src/core/support-bundle.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import type { InstallState } from "../../src/core/types.js";
import { channelHome } from "../helpers/channel-home.js";
import { BOT_TOKEN } from "../helpers/fake-telegram.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const MODEL_KEY = "sk-SENTINEL-model-key";
/** An outside contact the engine never knew by name, and their short Telegram id, inside engine error messages. */
const OUTSIDE = "Theodora Quince";
const SHORT_ID = "55555";
const NOT_FIRST = `step 'send' failed: The consent policy says a contact must write first; ${SHORT_ID} has not written on telegram`;
const NO_MEMBER = `No joined member is called '${OUTSIDE}'; joined: Ada`;
beforeEach(async () => {
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", await makeTempHome());
  await setSecret("telegram", BOT_TOKEN);
  await setSecret("model", MODEL_KEY);
});
afterEach(() => vi.unstubAllEnvs());

async function log(home: string, relative: string, line: string): Promise<void> {
  await mkdir(dirname(join(home, relative)), { recursive: true });
  await appendFile(join(home, relative), `${line}\n`);
}

/** A finished install full of personal data: members, a stranger's message, a memo, an approval, an answer, logs. */
async function personalHome(): Promise<string> {
  const home = await channelHome(true);
  const state = (await loadState(home)) as InstallState;
  await saveState(home, { ...state, roles: { decision_maker: "Marisol Okafor" }, work_dir: join(homedir(), "Desktop", "client-folder"), steps: { ...state.steps, "mode.decision-maker": { status: "done", at: AT, by: "human", value: "Marisol Okafor" } } });
  const { code } = await createInvite(home, "Quillon Vexmoor", state.roles, AT);
  await joinWithCode(home, code, { channel: "telegram", address: "7123456" }, AT);
  await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text: "SENTINEL-MESSAGE call me at +1 416 555 0199 or zed@example.org", message_id: "s1" }, AT), "event");
  const ctx = await toolContext(home, "cli", DEFAULT_TOOLS, () => AT);
  await invokeTool(ctx, "memo.add", { text: "SENTINEL-MEMO" });
  await invokeTool(ctx, "approvals.request", { tool: "memo.edit", args: { id: 1, text: "SENTINEL-APPROVAL" }, why: "Fix it." });
  await saveSource(home, { entity: "contact", connector: { id: "google-sheets", version: "1", sha256: "pinned" }, spreadsheet_id: "1SENTINELsheetid" });
  await log(home, LOG_FILE, JSON.stringify({ ts: AT, level: "error", loop: "telegram", error: "send to zed@example.org failed for Quillon Vexmoor (+1 416 555 0199)" }));
  await log(home, LOG_FILE, JSON.stringify({ ts: AT, level: "error", loop: "telegram", error: `reply to ${OUTSIDE} (chat ${SHORT_ID}) failed` }));
  await log(home, TICK_LOG, JSON.stringify({ status: "ran", errors: ["No joined member is called 'Marisol Okafor'", `events: ${NO_MEMBER}`, `resume: ${NOT_FIRST}`] }));
  await saveRun(home, { workflow: "outreach", run_id: "r1", key: "outreach:1", trigger: { kind: "manual" }, version: 1, status: "failed", started_at: AT, finished_at: AT, sandbox: false, pid: 1, actions: 0, needs_human: 0, reason: NOT_FIRST });
  await writeConfig(home, DOCTOR_FILE, { status: "warn", checked_at: AT, checks: [{ id: "recent_runs", status: "warn", detail: `in the last 24 hours: outreach r1 failed; report r2: ${NO_MEMBER}` }] });
  return home;
}

describe("installer support bundle (§16.5, D110)", () => {
  it("names the installer's version next to Node's, so a person can say which build they run (D119)", async () => {
    const result = await supportBundle(await personalHome(), () => AT);
    const bundle = JSON.parse(await readFile(result.file as string, "utf8"));
    const { version } = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    expect(bundle.versions).toEqual({ installer: version, node: process.version, platform: `${process.platform} ${process.arch}` });
  });
  it("holds the install's shape: versions, state without answers, report, runs, settings, counts, the audit check and the logs", async () => {
    const home = await personalHome();
    const result = await supportBundle(home, () => AT);
    expect(result).toMatchObject({ status: "written", file: join(home, "exports", "support-2026-10-08T12-00-00-000Z.json") });
    expect((await stat(result.file as string)).mode & 0o777).toBe(0o600);
    const bundle = JSON.parse(await readFile(result.file as string, "utf8"));
    expect(Object.keys(bundle)).toEqual(["format", "created_at", "versions", "state", "report", "doctor", "readiness", "runs", "settings", "counts", "audit", "secrets_present", "logs"]);
    expect(bundle.state.steps["mode.decision-maker"]).toEqual({ status: "done", at: AT, by: "human" });
    expect(bundle.state.work_dir).toBe("~/Desktop/client-folder");
    expect(bundle.report).toMatchObject({ overall: "ready", solution: "fixture-channels@1.0.0" });
    expect(bundle.counts).toMatchObject({ approvals: { pending: 1 }, members: { "member joined": 2, "decision_maker joined": 1 }, inbox: 1 });
    expect(bundle.secrets_present).toMatchObject({ telegram: true, model: true, skillswiki: false });
    expect(bundle.audit.check).toMatchObject({ ok: true });
    expect(bundle.logs.gateway).toHaveLength(2);
    for (const line of bundle.logs.gateway as string[]) expect(JSON.parse(line)).toMatchObject({ level: "error", loop: "telegram", error: "error" });
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"support.bundle_written"');
  });

  it("never holds a secret, a name, an address, a message, a record, an answer or the OS user's home folder", async () => {
    const home = await personalHome();
    const text = await readFile((await supportBundle(home, () => AT)).file as string, "utf8");
    for (const secret of [BOT_TOKEN, MODEL_KEY, "SENTINEL", "zed@example.org", "416 555", "Vexmoor", "Marisol", "Quince", "Theodora", homedir()]) expect(text).not.toContain(secret);
    for (const word of [/\bAda\b/, /\bOwner\b/, /\b1001\b/, /\b1002\b/, /\b7123456\b/, /\b5005\b/, /\b55555\b/, /desk_test_bot/]) expect(text).not.toMatch(word);
    expect(text).toContain(AT);
  });

  it("keeps only a fixed category of each error: run reasons, the doctor's recent runs and the tick log's errors", async () => {
    const home = await personalHome();
    const bundle = JSON.parse(await readFile((await supportBundle(home, () => AT)).file as string, "utf8"));
    expect(bundle.runs.recent.find((run: { run_id: string }) => run.run_id === "r1")).toMatchObject({ status: "failed", reason: "step failed" });
    expect(bundle.doctor.checks).toEqual([{ id: "recent_runs", status: "warn", detail: "in the last 24 hours: runs that failed or were missed, or report fallbacks (see runs)" }]);
    expect(JSON.parse(bundle.logs.tick[0])).toEqual({ status: "ran", errors: ["error", "events", "resume"] });
  });

  it("redacts the values of fields the contract tags personal, wherever they appear", () => {
    expect(scrub({ email: "a@b.co", nested: [{ name: "Ada", ok: "2026-10-08T12:00:00.000Z" }] }, [], new Set(["email", "name"]))).toEqual({ email: "[redacted]", nested: [{ name: "[redacted]", ok: "2026-10-08T12:00:00.000Z" }] });
    expect(scrub("Call +44 20 7946 0958 about Ada's case", ["Ada"], new Set())).toBe("Call [number] about [redacted]'s case");
  });
});
