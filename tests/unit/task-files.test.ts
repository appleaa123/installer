import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decide, handleHook, loadHookConfig, type HookConfig } from "../../src/core/agent-hook.js";
import { buildTaskArgv, type TaskRequest } from "../../src/core/agent-task.js";
import { MAX_ATTACHMENT_BYTES } from "../../src/core/mime.js";
import { loadProfileById } from "../../src/core/profile.js";
import { startRun } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { loadState, saveState } from "../../src/core/state.js";
import { chooseAttachments, chooseNote, NO_ATTACHMENT, NO_NOTE, NOTES_DIR } from "../../src/core/task-files.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 6a, Task 4 (D171): a task may Read only the exact files TaskFollow's code chose. */
const AT = "2026-10-16T12:00:00.000Z";
const OUTPUT = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
const readStep = (readFrom: string | undefined, mayUse: string[] = ["Read"]) => ({ id: "notes", task: { prompt: "Read the notes.", may_use: mayUse, ...(readFrom === undefined ? {} : { read_from: readFrom }), output: OUTPUT } });
const workflowWith = (step: object) => ({ workflow: "notes-flow", version: 1, description: "Reads notes", trigger: { manual: true }, steps: [step] });
const REF = "data/inbox-files/0123456789abcdef/invoice.pdf";

beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

async function hookFile(dir: string, config: object): Promise<string> {
  const file = join(dir, "hook.json");
  await writeFile(file, JSON.stringify(config));
  return file;
}

describe("a task step that reads a file: the workflow (Task 4)", () => {
  it("a step listing Read without read_from, or read_from without Read, is refused at load", () => {
    expect(() => parseWorkflow(workflowWith(readStep(undefined)), "notes-flow", DEFAULT_TOOLS)).toThrow("read_from");
    expect(() => parseWorkflow(workflowWith(readStep("meeting-notes", ["mcp__files__get"])), "notes-flow", DEFAULT_TOOLS)).toThrow("Read");
    expect(() => parseWorkflow(workflowWith(readStep("downloads")), "notes-flow", DEFAULT_TOOLS)).toThrow("read_from");
    const loaded = parseWorkflow(workflowWith(readStep("meeting-notes")), "notes-flow", DEFAULT_TOOLS);
    expect(loaded.steps[0]).toMatchObject({ kind: "task", task: { may_use: ["Read"], read_from: "meeting-notes" } });
  });
});

describe("a task step that reads a file: the agent's command (Task 4)", () => {
  const request = (mayUse: string[]): TaskRequest => ({ prompt: "p", input: null, may_use: mayUse, changes: false, output: OUTPUT, timeoutMs: 1000, record: "/r.calls.jsonl" });
  const valueAfter = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

  it("--allowedTools carries Read and --tools gains Read only when listed", async () => {
    const profile = await loadProfileById("claude-code");
    const argv = buildTaskArgv(profile, request(["Read"]), { settingsJson: "{}", mcpConfig: "{}" });
    expect(valueAfter(argv, "--allowedTools")).toContain("Read,");
    expect(valueAfter(argv, "--tools")).toBe("Read");
    expect(valueAfter(buildTaskArgv(profile, request(["mcp__shopify__get_order"]), { settingsJson: "{}", mcpConfig: "{}" }), "--tools")).toBe("");
  });

  it("builtinTools gives Bash,Read when both are listed", async () => {
    const profile = await loadProfileById("claude-code");
    expect(valueAfter(buildTaskArgv(profile, request(["Bash(shopify store execute:*)", "Read"]), { settingsJson: "{}", mcpConfig: "{}" }), "--tools")).toBe("Bash,Read");
  });
});

describe("a task step that reads a file: the hook (Task 4)", () => {
  it("Read with a path not listed is refused even though Read is in may_use", () => {
    const config: HookConfig = { record: "/r", may_use: ["Read"], changes: false, files: ["/home/x/data/inbox-files/a/invoice.pdf"] };
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/etc/passwd" } }, config).allow).toBe(false);
    expect(decide({ tool_name: "Read", tool_input: { file_path: "/home/x/data/inbox-files/a/invoice.pdf" } }, config).allow).toBe(false);
  });

  it("Read allows exactly a listed file, and refuses a relative path, a .., a link out, a folder and another file", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "read-hook-")));
    const allowed = join(dir, "invoice.pdf");
    await writeFile(allowed, "%PDF");
    await writeFile(join(dir, "other.pdf"), "%PDF");
    await symlink(join(dir, "other.pdf"), join(dir, "link.pdf"));
    const record = join(dir, "r.calls.jsonl");
    const config: HookConfig = { record, may_use: ["Read"], changes: false, files: [allowed] };
    const pre = async (filePath: unknown) => (await handleHook("pre", JSON.stringify({ tool_name: "Read", tool_input: { file_path: filePath } }), config, () => AT)).stdout;
    expect(await pre(allowed)).toBe("");
    for (const refused of ["invoice.pdf", join(dir, "sub", "..", "other.pdf"), join(dir, "link.pdf"), dir, join(dir, "other.pdf"), 42]) {
      expect(await pre(refused)).toContain('"permissionDecision":"deny"');
    }
  });

  it("Read is refused when no file was chosen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-hook-"));
    const config: HookConfig = { record: join(dir, "r.calls.jsonl"), may_use: ["Read"], changes: false };
    const out = await handleHook("pre", JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(dir, "x") } }), config, () => AT);
    expect(out.stdout).toContain("may read only the files TaskFollow gave it");
  });

  it("loadHookConfig refuses a files list that is not absolute paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "read-hook-"));
    await expect(loadHookConfig(await hookFile(dir, { record: "/r", may_use: ["Read"], changes: false, files: ["relative.pdf"] }))).rejects.toThrow("damaged");
    await expect(loadHookConfig(await hookFile(dir, { record: "/r", may_use: ["Read"], changes: false, files: "/a.pdf" }))).rejects.toThrow("damaged");
    expect((await loadHookConfig(await hookFile(dir, { record: "/r", may_use: ["Read"], changes: false, files: ["/a.pdf"] }))).files).toEqual(["/a.pdf"]);
  });
});

describe("which files the runner chooses (Task 4)", () => {
  it("attachments: exactly the saved files named in the input, inside data/inbox-files", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "data", "inbox-files", "0123456789abcdef"), { recursive: true });
    await writeFile(join(home, REF), "%PDF");
    const chosen = await chooseAttachments(home, { message: "see attached", attachments: [REF, "data/inbox-files/../../state/install-state.json", "/etc/passwd", "data/inbox-files/fedcba9876543210/missing.pdf"] });
    expect(chosen).toEqual([{ name: "invoice.pdf", path: await realpath(join(home, REF)) }]);
  });

  it("attachments: a saved file that is a link out of data/inbox-files is dropped before the agent runs", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "data", "inbox-files", "0123456789abcdef"), { recursive: true });
    await writeFile(join(home, "secret.txt"), "x");
    await symlink(join(home, "secret.txt"), join(home, REF));
    expect(await chooseAttachments(home, { attachments: [REF] })).toEqual([]);
  });

  async function notesFolder(): Promise<string> {
    const work = await realpath(await mkdtemp(join(tmpdir(), "install-folder-")));
    await mkdir(join(work, NOTES_DIR));
    return work;
  }

  it("meeting-notes: the newest regular file is chosen", async () => {
    const work = await notesFolder();
    await writeFile(join(work, NOTES_DIR, "old.md"), "old");
    await writeFile(join(work, NOTES_DIR, "new.md"), "new");
    await utimes(join(work, NOTES_DIR, "old.md"), new Date("2026-10-01"), new Date("2026-10-01"));
    await utimes(join(work, NOTES_DIR, "new.md"), new Date("2026-10-15"), new Date("2026-10-15"));
    expect(await chooseNote(work)).toEqual({ name: "new.md", path: join(work, NOTES_DIR, "new.md") });
  });

  it("meeting-notes: a symbolic link pointing out of the folder is skipped", async () => {
    const work = await notesFolder();
    await writeFile(join(work, "outside.md"), "secret");
    await symlink(join(work, "outside.md"), join(work, NOTES_DIR, "link.md"));
    expect(await chooseNote(work)).toBeNull();
  });

  it("meeting-notes: a directory or other non-file entry is skipped", async () => {
    const work = await notesFolder();
    await mkdir(join(work, NOTES_DIR, "folder.md"));
    expect(await chooseNote(work)).toBeNull();
  });

  it("meeting-notes: a file over the size cap is skipped", async () => {
    const work = await notesFolder();
    await writeFile(join(work, NOTES_DIR, "huge.md"), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    expect(await chooseNote(work)).toBeNull();
  });

  it("meeting-notes: a folder that is a symbolic link is refused", async () => {
    const work = await realpath(await mkdtemp(join(tmpdir(), "install-folder-")));
    const elsewhere = await mkdtemp(join(tmpdir(), "elsewhere-"));
    await writeFile(join(elsewhere, "notes.md"), "x");
    await symlink(elsewhere, join(work, NOTES_DIR));
    await expect(chooseNote(work)).rejects.toThrow("symbolic link");
  });
});

describe("no usable file means no agent run (Task 4)", () => {
  async function notesHome(): Promise<{ home: string; work: string }> {
    const home = await runnerHome();
    const work = await realpath(await mkdtemp(join(tmpdir(), "install-folder-")));
    await mkdir(join(work, NOTES_DIR));
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, work_dir: work });
    return { home, work };
  }

  it("meeting-notes: an empty folder gives the plain message and starts no agent", async () => {
    const { home } = await notesHome();
    const workflow = parseWorkflow(workflowWith(readStep("meeting-notes")), "notes-flow", DEFAULT_TOOLS);
    const run = await startRun({ home, workflow, key: `notes-flow:${AT}`, trigger: { kind: "manual" }, now: () => AT, sandbox: false });
    expect(run).toMatchObject({ status: "completed", reason: NO_NOTE });
    expect((await loadStep(home, run, "notes"))?.skipped).toBe(true);
  });

  it("attachments: no usable attachment starts no agent", async () => {
    const { home } = await notesHome();
    const step = { id: "read", task: { prompt: "Read the invoice.", input: { attachments: [] }, may_use: ["Read"], read_from: "attachments", output: OUTPUT } };
    const workflow = parseWorkflow(workflowWith(step), "notes-flow", DEFAULT_TOOLS);
    const run = await startRun({ home, workflow, key: `notes-flow:${AT}`, trigger: { kind: "manual" }, now: () => AT, sandbox: false });
    expect(run).toMatchObject({ status: "completed", reason: NO_ATTACHMENT });
  });
});
