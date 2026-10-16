import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeInbound } from "../../src/core/envelope.js";
import { storeInbound } from "../../src/core/inbox.js";
import { resumeRun, startRun } from "../../src/core/runner.js";
import { loadStep, type RunRecord } from "../../src/core/runs.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { invokeTool, toolContext } from "../../src/core/tools.js";
import { parseWorkflow } from "../../src/core/workflow.js";
import { runnerHome } from "../helpers/runner-home.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Item 5: the inbox triage reads only what is new since the last run whose list was made (Review Focus 1). */
const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T12:00:00.000Z`;
beforeEach(async () => vi.stubEnv("FAKE_AGENT_HOME", await makeTempHome()));
afterEach(() => vi.unstubAllEnvs());

const answers = (...values: unknown[]) => vi.stubEnv("FAKE_AGENT_JUDGE", JSON.stringify(values));
const MAIL = { id: "mail", tool: "channel.inbox", args: { limit: 50, after: "last-run" } };
const TRIAGE = { id: "triage", agent: { instructions: "Make the daily list.", input: "${mail}", tools: ["memo.list"] } };
const HOLD = { id: "hold", approve: { tool: "memo.edit", args: { id: 1, text: "a reply" }, why: "A reply waits for a person" } };
const TRIAGE_FLOW = { workflow: "inbox-triage", version: 1, trigger: { manual: true }, steps: [MAIL, TRIAGE] };
const parse = (value: Record<string, unknown>) => parseWorkflow(value, String(value.workflow), DEFAULT_TOOLS);

let mails = 0;
async function mailArrives(home: string, text: string): Promise<void> {
  const n = String(++mails);
  await storeInbound(home, normalizeInbound({ channel: "telegram", from: `7${n}`, thread: `7${n}`, text, message_id: `w${n}` }, at(1)), "event");
}
/** A memo for the replies run's approve step to change, so it waits for a person (memo.edit is L2). */
const repliesHome = async (): Promise<string> => {
  const home = await runnerHome();
  await invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS, () => at(1)), "memo.add", { text: "draft" });
  return home;
};
const run = (home: string, day: number, value: Record<string, unknown> = TRIAGE_FLOW, sandbox = false) =>
  startRun({ home, workflow: parse(value), key: `${String(value.workflow)}:${at(day)}`, trigger: { kind: "manual" }, now: () => at(day), sandbox });
const read = async (home: string, record: RunRecord): Promise<string[]> =>
  (((await loadStep(home, record, "mail"))?.output as { messages: { text: string }[] }).messages).map((message) => message.text);
const done = { tool: "done", summary: "the list" };

describe("a workflow reading the inbox with after: last-run (item 5)", () => {
  it("after last-run is null on the first run", async () => {
    const home = await runnerHome();
    await mailArrives(home, "heating broken");
    answers(done);
    const first = await run(home, 2);
    expect(first.status).toBe("completed");
    expect(await read(home, first)).toEqual(["heating broken"]);
  });

  it("lists each message once over two runs", async () => {
    const home = await runnerHome();
    await mailArrives(home, "one");
    answers(done, done);
    await run(home, 2);
    await mailArrives(home, "two");
    expect(await read(home, await run(home, 3))).toEqual(["two"]);
  });

  it("a waiting run's mail is not repeated (its list was made)", async () => {
    const home = await repliesHome();
    await mailArrives(home, "one");
    answers(done, done);
    const replies = { ...TRIAGE_FLOW, workflow: "inbox-triage-replies", steps: [MAIL, TRIAGE, HOLD] };
    expect((await run(home, 2, replies)).status).toBe("waiting");
    await mailArrives(home, "two");
    expect(await read(home, await run(home, 3, replies))).toEqual(["two"]);
  });

  it("a replies run whose approvals expired does not make the next run repeat its mail", async () => {
    const home = await repliesHome();
    await mailArrives(home, "one");
    answers(done, done);
    const replies = { ...TRIAGE_FLOW, workflow: "inbox-triage-replies", steps: [MAIL, TRIAGE, HOLD] };
    const first = await run(home, 2, replies);
    const expired = await resumeRun({ home, workflow: parse(replies), key: first.key, trigger: first.trigger, now: () => at(4) }, first);
    expect(expired.status).not.toBe("waiting");
    await mailArrives(home, "two");
    expect(await read(home, await run(home, 5, replies))).toEqual(["two"]);
  });

  it("a run whose triage failed lists its mail again, never lost", async () => {
    const home = await runnerHome();
    await mailArrives(home, "one");
    answers({ tool: "memo.nope", args: {} });
    expect((await run(home, 2)).status).not.toBe("completed");
    answers(done);
    await mailArrives(home, "two");
    expect(await read(home, await run(home, 3))).toEqual(["one", "two"]);
  });

  it("a run whose triage ended with needs lists its mail again", async () => {
    const home = await runnerHome();
    await mailArrives(home, "one");
    const once = { ...TRIAGE_FLOW, steps: [MAIL, { ...TRIAGE, agent: { ...TRIAGE.agent, max_turns: 1 } }] };
    answers({ tool: "memo.list", args: {} });
    await run(home, 2, once);
    answers(done);
    expect(await read(home, await run(home, 3, once))).toEqual(["one"]);
  });

  it("sandbox and live runs keep separate places", async () => {
    const home = await runnerHome();
    await mailArrives(home, "one");
    answers(done, done);
    await run(home, 2, TRIAGE_FLOW, true);
    expect(await read(home, await run(home, 3))).toEqual(["one"]);
  });

  it.each([
    [{ ...TRIAGE_FLOW, steps: [MAIL] }, "needs an agent step after it"],
    [{ ...TRIAGE_FLOW, steps: [TRIAGE, MAIL] }, "needs an agent step after it"],
    [{ ...TRIAGE_FLOW, steps: [{ id: "x", tool: "memo.add", args: { text: "last-run" } }, TRIAGE] }, "only as channel.inbox's after"],
    [{ ...TRIAGE_FLOW, steps: [{ ...MAIL, args: { limit: "last-run", after: "last-run" } }, TRIAGE] }, "only as channel.inbox's after"],
  ])("last-run in the wrong place is refused (%#)", (value, message) => {
    expect(() => parse(value)).toThrow(message);
  });
});
