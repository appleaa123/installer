import { describe, expect, it } from "vitest";
import { checkCommand } from "../../src/core/check-commands.js";
import { recordResult } from "../../src/core/checks.js";
import { saveWorkflowState } from "../../src/core/sandbox.js";
import { loadState } from "../../src/core/state.js";
import { runnerHome } from "../helpers/runner-home.js";
import { writeWorkflow } from "../helpers/workflow-home.js";
import { workflowHash, descriptionHash } from "../../src/core/homes.js";

/** Plan Task 11 (spec section 6): the person's page for one workflow, with glosses and honest Home 2 wording. */
const AT = "2026-10-16T12:00:00.000Z";
const BRIEF = { workflow: "brief", version: 1, description: "Read my inbox and send me a brief", trigger: { manual: true }, steps: [{ id: "list", tool: "memo.list", args: {} }] };
const ctx = { interactive: false, now: () => AT, launch: async () => ({ pid: 0, opened: true }) };
const summary = async (home: string, value?: Record<string, unknown>) => checkCommand(home, (await loadState(home)) ?? undefined, ["summary", "brief"], value ? { value: JSON.stringify(value) } : {}, ctx) as Promise<{ lines: string[]; home: string; text: string }>;
const result = (need: string, agent: string, kind: "yes-tested" | "yes-you-told-us" | "not-checked", test: string, reason: string) =>
  ({ need, workflow: "brief", result: kind, reason, at: AT, agent, agent_version: null, test }) as Parameters<typeof recordResult>[1];

describe("check summary: the person's page for a workflow (plan Task 11)", () => {
  it("says 'nobody has seen it yet' before any test, and where it would run", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, BRIEF);
    const out = await summary(home);
    expect(out.text).toContain("Read my inbox and send me a brief");
    expect(out.text).toContain("not checked (nobody has seen it yet)");
    expect(out.home).toBe("draft-only");
  });

  it("shows the person's own sightings as 'you saw it', and Home 2 honestly", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, BRIEF);
    const raw = { ...BRIEF };
    await saveWorkflowState(home, { workflow: "brief", sandbox: true, described: { description_hash: descriptionHash(BRIEF.description), content_hash: workflowHash(raw), sends_to_others: false, writes_or_deletes: false, at: AT } });
    await recordResult(home, result("answers", "fake-agent", "yes-you-told-us", "once", "You saw it: the work was done once and you said it looked right"));
    for (const need of ["scheduler", "reads:email", "skills"]) await recordResult(home, result(need, "Claude Cowork", "yes-you-told-us", "t8", "You told us: it arrived around the set time"));
    const out = await summary(home, { agent: "Claude Cowork", while_away: true });
    expect(out.home).toBe("agent-scheduler");
    expect(out.text).toContain("✅ Done once, now");
    expect(out.text).toContain("yes, you told us (you saw it)");
    expect(out.text).toContain("TaskFollow is not in the path there");
    expect(out.text).toContain("on this home TaskFollow cannot check that");
    expect(out.text).not.toContain("no approval is needed");
  });

  it("lowers the schedule's result when the person says a brief did not arrive (check missed), never raises it", async () => {
    const home = await runnerHome();
    await writeWorkflow(home, BRIEF);
    await recordResult(home, result("scheduler", "Claude Cowork", "yes-you-told-us", "t8", "You told us: it arrived"));
    const out = (await checkCommand(home, (await loadState(home)) ?? undefined, ["missed", "brief"], { value: JSON.stringify({ agent: "Claude Cowork" }) }, ctx)) as Record<string, unknown>;
    expect(out).toMatchObject({ need: "scheduler", result: "not checked" });
    const after = await summary(home, { agent: "Claude Cowork" });
    expect(after.text).toContain("did not arrive");
  });
});
