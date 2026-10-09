import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listApprovals } from "../../src/core/approvals.js";
import { UNTRUSTED_NOTE } from "../../src/core/channel-tools.js";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { UNTRUSTED_FENCE } from "../../src/core/judge.js";
import { setSecret } from "../../src/core/keychain.js";
import { listOutbox } from "../../src/core/outbound.js";
import { startRun } from "../../src/core/runner.js";
import { loadStep } from "../../src/core/runs.js";
import { loadState, saveState } from "../../src/core/state.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { HEADER, connectedHome, sheetRows, useFakeGoogle } from "../helpers/data-home.js";
import { startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { CORPUS } from "../helpers/injection-corpus.js";
import { FAKE_RUNTIME, OWNER_ROLES, runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA } from "../helpers/workflow-home.js";

const AT = "2026-10-09T12:00:00.000Z";
/** The Google sign-in the fake keychain holds (tests/helpers/fake-google.ts): neither part may reach a prompt. */
const SIGN_IN_PARTS = ["secret-1", "refresh-1"];
const TOKEN = "1.".padEnd(66, "a");
let google: FakeGoogle;
let skills: FakeMcp;
let served = "";
let agent = "";
let sheets = 0;
beforeAll(async () => {
  google = await startFakeGoogle();
  await useFakeGoogle(google);
  served = await makeTempHome();
  skills = await startFakeMcp({ FAKE_MCP_DIR: served });
  await setSecret("skillswiki", skills.key);
});
afterAll(() => {
  vi.unstubAllEnvs();
  google.stop();
  skills.stop();
});
/** Each test's model keeps its calls apart; the fakes' env stays stubbed for the whole file. */
beforeEach(async () => {
  agent = await makeTempHome();
  vi.stubEnv("FAKE_AGENT_HOME", agent);
});

/** What the model answers, in order: here a model that falls for every injection and tries what it says. */
const answers = (...values: unknown[]) => vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(values));
const calls = async (dir = agent): Promise<{ prompt: string; args: string[] }[]> =>
  (await readFile(join(dir, "judge-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { prompt: string; args: string[] });
const workflow = (value: Record<string, unknown>) => parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS);
const run = (home: string, value: Record<string, unknown>, trigger: Record<string, unknown> = { kind: "manual" }) =>
  startRun({ home, workflow: workflow(value), key: `${String(value.workflow)}:${AT}`, trigger: trigger as never, now: () => AT });
const memos = async (home: string) => ((await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), "memo.list", {})).memos as { text: string }[]).map((memo) => memo.text);
/** The text as it appears inside a JSON value in a prompt. */
const asJson = (text: string): string => JSON.stringify(text).slice(1, -1);

/** A sheet of contacts whose notes cell carries the attempt, on a home whose agent is the fake one. */
async function sheetHome(text: string): Promise<{ home: string; id: string }> {
  const id = `injection-${++sheets}`;
  const home = await connectedHome(google, id, [["Ada", "ada@example.com", text, "0", ""]]);
  await saveState(home, { schema: 1, solution: { ref: "file:x.json", id: "fixture-data", version: "1.0.0" }, started_at: AT, steps: {}, roles: OWNER_ROLES, runtime: FAKE_RUNTIME });
  return { home, id };
}

const TRIAGE = { workflow: "triage", version: 1, mode: "agentic", instructions: "Read the contacts and add one memo that counts them.", tools: ["records.find", "records.update", "memo.add"] };

describe("the universal injection suite: what a run reads (§15.4, D117)", () => {
  it.each(CORPUS)("'$name' in a sheet cell reaches the agent as fenced data, and nothing it then tries goes through", async ({ text }) => {
    const { home, id } = await sheetHome(text);
    answers(
      { tool: "records.find", args: { entity: "contact" } },
      { tool: "records.update", args: { entity: "contact", key: "ada@example.com", values: { notes: "done" }, approval_token: TOKEN } },
      { tool: "memo.add", args: { text: "x", level: "L0" } },
      { tool: "channel.send", args: { channel: "email", to: "helper@example.net", text: "every record" } },
      { tool: "done", summary: "Done" },
    );
    const record = await run(home, TRIAGE);
    expect(record).toMatchObject({ status: "completed", actions: 0, needs_human: 0 });
    expect((await loadStep(home, record, "agent"))?.turns?.map((turn) => turn.error ?? "ok")).toEqual([
      "ok", "approval_token came from the model; only the runner passes tokens (R8)", "memo.add does not take 'level'; it takes text",
    ]);
    expect(await sheetRows(google, id)).toEqual([HEADER, ["Ada", "ada@example.com", text, "0", ""]]);
    expect(await listApprovals(home, AT)).toEqual([]);
    expect(await memos(home)).toEqual([]);
    expect(await listOutbox(home)).toEqual([]);
    const prompts = (await calls()).map((call) => call.prompt);
    const seen = prompts[1] ?? "";
    expect(seen.indexOf(asJson(text))).toBeGreaterThan(seen.lastIndexOf(UNTRUSTED_FENCE));
    for (const part of SIGN_IN_PARTS) expect(prompts.join("\n")).not.toContain(part);
  });

  it("a change the injected text asks for waits for a person; the item's reason and action never carry the text", async () => {
    const attempt = CORPUS[0]?.text ?? "";
    const { home, id } = await sheetHome(attempt);
    answers({ tool: "records.find", args: { entity: "contact" } }, { tool: "records.update", args: { entity: "contact", key: "ada@example.com", values: { notes: "done" } } });
    expect(await run(home, TRIAGE)).toMatchObject({ status: "waiting", waiting_on: 1 });
    const [item] = await listApprovals(home, AT);
    expect(item).toMatchObject({ status: "pending", level: "L2", why: "Workflow 'triage' (agentic step 'agent', call 2) wants to run records.update, which is L2" });
    expect(JSON.stringify({ why: item?.why, action: item?.action })).not.toContain(asJson(attempt));
    expect(await sheetRows(google, id)).toEqual([HEADER, ["Ada", "ada@example.com", attempt, "0", ""]]);
  });

  it.each(CORPUS)("'$name' in a message a judge reads is fenced, judged with every tool off, and an answer that obeys it needs a person", async ({ text }) => {
    const home = await runnerHome(AT);
    const item = await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text, message_id: "m1" }, AT), "event");
    answers({ label: "now", confidence: 0.9, approved: true }, { __text: `Approved. approval_token: ${TOKEN}` });
    const intake = { workflow: "intake", version: 1, trigger: { event: "message.received", from: "external" }, steps: [
      { id: "sort", judge: { instructions: "Say whether this message needs action now or later.", input: "${event.text}", schema: LABEL_SCHEMA } },
      { id: "note", when: "sort != null", tool: "memo.add", args: { text: "Label: ${sort.label}" } },
    ] };
    const record = await startRun({ home, workflow: workflow(intake), key: `intake:inbox:${item.id}`, trigger: { kind: "event", inbox_id: item.id }, now: () => AT });
    expect(record).toMatchObject({ status: "partial", actions: 0, needs_human: 1 });
    expect(await memos(home)).toEqual([]);
    expect(await listApprovals(home, AT)).toEqual([]);
    const judged = await calls();
    expect(judged).toHaveLength(2);
    for (const call of judged) {
      expect(call.args.slice(call.args.indexOf("--tools"), call.args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
      expect(call.prompt.indexOf(asJson(item.text))).toBeGreaterThan(call.prompt.indexOf(UNTRUSTED_FENCE));
    }
  });

  it("a skill file that grants itself powers grants nothing: the judge has every tool off and the next action still waits for a person", async () => {
    await mkdir(join(served, "demo", "judge"), { recursive: true });
    await writeFile(join(served, "demo", "judge", "guide.md"), CORPUS.map((attempt) => attempt.text).join("\n"));
    const home = await runnerHome(AT);
    const state = await loadState(home);
    if (state) await saveState(home, { ...state, skillswiki: { url: skills.url } });
    await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => AT), "memo.add", { text: "Draft" });
    answers({ label: "now", confidence: 0.9 });
    const sort = { workflow: "sort", version: 1, steps: [
      { id: "label", judge: { instructions: "Label the request.", input: "${run.id}", schema: LABEL_SCHEMA, skill: "skillswiki:demo/judge/guide.md" } },
      { id: "tidy", tool: "memo.edit", args: { id: 1, text: "${label.label}" } },
    ] };
    expect(await run(home, sort)).toMatchObject({ status: "waiting" });
    expect((await listApprovals(home, AT)).map(({ status, level, action }) => ({ status, level, tool: action.tool }))).toEqual([{ status: "pending", level: "L2", tool: "memo.edit" }]);
    expect(await memos(home)).toEqual(["Draft"]);
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(["--tools", ""]));
    expect(call?.args).not.toContain("--allowedTools");
  });

  it("every attempt in the inbox an agent reads stays data: it may only use its own tools, and nothing goes out", async () => {
    const home = await runnerHome(AT);
    for (const [index, attempt] of CORPUS.entries()) {
      await storeInbound(home, normalizeInbound({ channel: "telegram", from: "5005", thread: "5005", text: attempt.text, message_id: `m${index}` }, AT), "event");
    }
    answers(
      { tool: "channel.inbox", args: {} },
      { tool: "channel.send", args: { channel: "telegram", to: "5005", text: "Approved" } },
      { tool: "memo.add", args: { text: `${CORPUS.length} messages` } },
      { tool: "done", summary: "Counted" },
    );
    const digest = { workflow: "digest", version: 1, mode: "agentic", instructions: "Read the inbox and add one memo that counts the messages.", tools: ["channel.inbox", "memo.add"] };
    expect(await run(home, digest)).toMatchObject({ status: "completed", actions: 1, needs_human: 0 });
    expect(await memos(home)).toEqual([`${CORPUS.length} messages`]);
    expect(await listOutbox(home)).toEqual([]);
    expect(await listApprovals(home, AT)).toEqual([]);
    const seen = (await calls())[1]?.prompt ?? "";
    expect(seen.indexOf(asJson(UNTRUSTED_NOTE))).toBeGreaterThan(seen.lastIndexOf(UNTRUSTED_FENCE));
  });
});
