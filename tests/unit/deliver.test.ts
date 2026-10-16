import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deliverToCowork, scheduleWords } from "../../src/core/deliver.js";
import { setSecret } from "../../src/core/keychain.js";
import { loadState, saveState } from "../../src/core/state.js";
import { readZip, storedZip } from "../../src/core/zip.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { runnerHome } from "../helpers/runner-home.js";

/** Plan Task 9 (spec section 10, D158): a workflow for Claude Cowork as a skill zip plus schedule text, checked first. */
const AT = "2026-10-16T12:00:00.000Z";
const brief = (description: string, extra: Record<string, unknown> = {}) => parseWorkflow({ workflow: "morning-brief", version: 1, description, mode: "agentic", instructions: description, tools: ["channel.inbox"], trigger: { cron: "0 8 * * 1-5", tz: "America/Toronto" }, ...extra }, "morning-brief", DEFAULT_TOOLS);

async function install() {
  const home = await runnerHome();
  const work = await makeTempHome();
  const state = await loadState(home);
  if (state) await saveState(home, { ...state, work_dir: work });
  return { home, work };
}

describe("zip: a small stored zip with a real central directory (plan review 11)", () => {
  it("round-trips names and bytes, with CRCs that a reader checks", () => {
    const zip = storedZip([{ name: "a/", data: Buffer.alloc(0) }, { name: "a/SKILL.md", data: Buffer.from("hello\n") }]);
    expect(readZip(zip)).toEqual([{ name: "a/", data: Buffer.alloc(0) }, { name: "a/SKILL.md", data: Buffer.from("hello\n") }]);
  });
});

describe("deliver: a workflow for Claude Cowork (plan Task 9)", () => {
  it("writes one top folder with SKILL.md at its top and no plugin manifest, rules inside, and the schedule text with its footer", async () => {
    const { home, work } = await install();
    const rules = join(work, ".claude", "skills", "morning-brief", "references");
    await mkdir(rules, { recursive: true });
    await writeFile(join(work, ".claude", "skills", "morning-brief", "SKILL.md"), "---\nname: morning-brief\ndescription: Use for the owner's morning brief.\n---\n\nRead my inbox and tell me what needs a visit.\n");
    await writeFile(join(rules, "my-rules.md"), "# My rules\n\nFlag repairs first.\n");
    const out = await deliverToCowork(home, brief("Read my inbox each morning and tell me what needs a visit."), { now: AT });
    const entries = readZip(await readFile(out.zip));
    const names = entries.map((entry) => entry.name);
    expect(names).toEqual(["morning-brief/", "morning-brief/SKILL.md"]);
    expect(names.some((name) => name.includes(".claude-plugin"))).toBe(false);
    const skill = entries[1]?.data.toString("utf8") ?? "";
    expect(skill).toMatch(/^---\nname: morning-brief\n/);
    expect(skill).toContain("Flag repairs first.");
    expect(out.schedule).toContain("every weekday at 08:00 (America/Toronto)");
    expect(out.schedule).toContain("Sent by your scheduled TaskFollow workflow morning-brief");
    expect(out.schedule).toContain("SendUserMessage");
    expect(out.steps.join(" ")).toContain("Settings, then Skills");
    expect(out.steps.join(" ")).toContain("Cowork cannot delete them from a chat");
  });

  it("generates the skill from the description when the install folder has none", async () => {
    const { home } = await install();
    const out = await deliverToCowork(home, brief("Read my inbox and list what matters."), { now: AT });
    expect(readZip(await readFile(out.zip))[1]?.data.toString("utf8")).toContain("Read my inbox and list what matters.");
  });

  it.each([
    ["a keychain value", "Use the token tg-real-secret-123456 to read."],
    ["a token pattern", "Call with ghp_abcdefghijklmnop1234 please."],
    ["a local path", "Read the file /Users/someone/notes.txt each morning."],
    ["a taskfollow command", "Then run taskfollow approvals list for me."],
  ])("refuses %s in the delivered text, without repeating it", async (_kind, description) => {
    const { home } = await install();
    await setSecret("telegram", "tg-real-secret-123456");
    const failed = deliverToCowork(home, brief(description), { now: AT });
    await expect(failed).rejects.toThrow(/remove it from the workflow's description or rules/);
    await expect(failed).rejects.not.toThrow(/tg-real-secret|ghp_abc/);
  });

  it("says schedules in plain words", () => {
    expect(scheduleWords({ kind: "cron", cron: "30 7 * * *", tz: "Europe/London", tolerance_minutes: 5 })).toBe("every day at 07:30 (Europe/London)");
    expect(scheduleWords({ kind: "cron", cron: "0 9 * * 1", tz: "UTC", tolerance_minutes: 5 })).toBe("every Monday at 09:00 (UTC)");
    expect(scheduleWords({ kind: "manual" })).toBe("every weekday at 08:00, or at the time you prefer");
  });
});
