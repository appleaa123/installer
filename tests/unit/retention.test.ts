import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE, verifyAudit } from "../../src/core/audit.js";
import { SENT_DIR, recordSent } from "../../src/core/channel-policy.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { SEEN_DIR } from "../../src/core/inbound.js";
import { hasWrittenFirst, listInbox, storeInbound } from "../../src/core/inbox.js";
import { listIds } from "../../src/core/numbered.js";
import { OUTBOX_DIR, recordAction } from "../../src/core/outbound.js";
import { DEFAULT_RETENTION_DAYS, loadRetention, pruneOld, retentionCommand } from "../../src/core/retention.js";
import { startRun } from "../../src/core/runner.js";
import { KEYS_DIR, listRuns, runForKey } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";

const AT = "2026-10-08T12:00:00.000Z";
const OLD = "2026-06-01T12:00:00.000Z";
const RECENT = "2026-10-01T12:00:00.000Z";
const AGENT = { interactive: false };
const PERSON = { interactive: true, as: "Owner" };
const NOTE = parseWorkflow({ workflow: "note", version: 1, steps: [{ id: "add", tool: "memo.add", args: { text: "x" } }] }, "note", DEFAULT_TOOLS);
const TIDY = parseWorkflow({ workflow: "tidy", version: 1, steps: [{ id: "drop", approve: { tool: "memo.delete", args: { id: 1 }, why: "Tidy up" } }] }, "tidy", DEFAULT_TOOLS);

const events = async (home: string): Promise<string[]> => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);
const keyPath = (home: string, key: string): string => join(home, KEYS_DIR, createHash("sha256").update(key).digest("hex"));
const message = (from: string, text: string, at: string, id: string) => normalizeInbound({ channel: "telegram", from, thread: from, text, message_id: id }, at);

describe("retention (§14.5, D102)", () => {
  it("keeps 90 days unless told; a longer period may come from anywhere, a shorter one only from a person's terminal", async () => {
    const home = await runnerHome();
    expect(await loadRetention(home)).toEqual({ days: DEFAULT_RETENTION_DAYS });
    expect(await retentionCommand(home, "120", AGENT, () => AT)).toMatchObject({ status: "saved", retention: { days: 120, by: "agent" } });
    await expect(retentionCommand(home, "30", AGENT, () => AT)).rejects.toThrow("in their own terminal");
    expect(await events(home)).toContain("retention.refused");
    expect((await loadRetention(home)).days).toBe(120);
    expect(await retentionCommand(home, "30", PERSON, () => AT)).toMatchObject({ retention: { days: 30, by: "Owner" } });
    await expect(retentionCommand(home, "3", PERSON, () => AT)).rejects.toThrow("from 7 to 3650");
  });

  it("deletes finished runs older than the period with their keys, and keeps unfinished and recent ones", async () => {
    const home = await runnerHome();
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => OLD), "memo.add", { text: "One" });
    const old = await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => OLD });
    const waiting = await startRun({ home, workflow: TIDY, key: "tidy:old", trigger: { kind: "manual" }, now: () => OLD });
    await startRun({ home, workflow: NOTE, key: "note:recent", trigger: { kind: "manual" }, now: () => RECENT });
    expect([old.status, waiting.status]).toEqual(["completed", "waiting"]);
    expect(await pruneOld(home, AT)).toMatchObject({ runs: 1 });
    expect((await listRuns(home)).map((run) => `${run.workflow}:${run.status}`)).toEqual(["tidy:waiting", "note:completed"]);
    expect(await runForKey(home, "note:old")).toBeNull();
    await expect(access(keyPath(home, "note:old"))).rejects.toThrow();
  });

  it("deletes old inbound messages and recordings but keeps the newest of each, and remembers who wrote first", async () => {
    const home = await runnerHome();
    await storeInbound(home, message("5005", "Hello", OLD, "a"), "event");
    await storeInbound(home, message("5006", "Hi", OLD, "b"), "event");
    await recordAction(home, { tool: "memo.add", args: { text: "a" } }, "L1", OLD);
    await recordAction(home, { tool: "memo.add", args: { text: "b" } }, "L1", OLD);
    expect(await pruneOld(home, AT)).toMatchObject({ inbox: 1, recordings: 1 });
    expect((await listInbox(home)).map((item) => item.id)).toEqual([2]);
    expect(await listIds(home, OUTBOX_DIR)).toEqual([2]);
    expect(await hasWrittenFirst(home, { channel: "telegram", address: "5005" })).toBe(true);
    expect(await hasWrittenFirst(home, { channel: "telegram", address: "5007" })).toBe(false);
    expect((await storeInbound(home, message("5007", "New", AT, "c"), "event")).id).toBe(3);
  });

  it("deletes old sent counts and seen markers too", async () => {
    const home = await runnerHome();
    await recordSent(home, { channel: "telegram", address: "5005" }, OLD);
    await recordSent(home, { channel: "telegram", address: "5005" }, OLD);
    await mkdir(join(home, SEEN_DIR), { recursive: true });
    await writeFile(join(home, SEEN_DIR, "old-marker"), "");
    await utimes(join(home, SEEN_DIR, "old-marker"), new Date(OLD), new Date(OLD));
    await writeFile(join(home, SEEN_DIR, "new-marker"), "");
    expect(await pruneOld(home, AT)).toMatchObject({ sent: 1, seen: 1 });
    expect(await listIds(home, SENT_DIR)).toEqual([2]);
    expect(await readdir(join(home, SEEN_DIR))).toEqual(["new-marker"]);
  });

  it("never deletes from the audit: it only grows, its chain still verifies, and nothing is pruned within the period", async () => {
    const home = await runnerHome();
    await startRun({ home, workflow: NOTE, key: "note:old", trigger: { kind: "manual" }, now: () => OLD });
    const before = (await events(home)).length;
    await pruneOld(home, AT);
    expect((await events(home)).length).toBe(before + 1);
    expect((await events(home)).at(-1)).toBe("retention.pruned");
    expect(await verifyAudit(home)).toEqual({ ok: true, lines: before + 1 });
    expect(await pruneOld(home, AT)).toEqual({ runs: 0, inbox: 0, recordings: 0, sent: 0, seen: 0, direct_calls: 0, settings_backups: 0 });
    expect((await events(home)).length).toBe(before + 1);
  });
});
