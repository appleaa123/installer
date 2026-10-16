import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { runTask } from "./agent-task.js";
import { listChannels } from "./channels.js";
import { CHECKS_DIR, cancelChallenge, loadChallenge, recordResult, startChallenge, type Need } from "./checks.js";
import { loadProfileById } from "./profile.js";
import { skillsBlock } from "./skills.js";
import type { InstallState } from "./types.js";
import type { Workflow } from "./workflow.js";

/**
 * T7 (spec 5.2, D159): TaskFollow's own runner as a home. TaskFollow runs one real task step through its runner, under
 * the hook, allowed only `check.ping`. It passes only when the ping arrived through MCP and the step's call record
 * shows it under the hook: a ping from anywhere else (the word is visible to the computer's user) does not count.
 * Per workflow, a test skill holding the word is added to the workflow's inlined skills (D153, D154), so the word
 * reaches the task only through the skills block.
 */
const RUN_MS = 5 * 60_000;
const PING_RULE = "mcp__installer__check_ping";
const OUTPUT = { type: "object", properties: { done: { type: "boolean" } }, required: ["done"] } as const;
const NOT_A_HOME = "TaskFollow cannot run this agent unattended here, so its own runner is not a home for it";

export interface RunnerCheckOptions {
  readonly now: () => string;
  readonly workflow?: Workflow;
  readonly env?: NodeJS.ProcessEnv;
}

const usesTool = (workflow: Workflow, tool: string): boolean => workflow.steps.some((step) => (step.kind === "agent" && step.agent.tools.includes(tool)) || (step.kind === "tool" && step.tool === tool) || (step.kind === "approve" && step.tool === tool));

async function pingUnderHook(record: string): Promise<boolean> {
  try {
    return (await readFile(record, "utf8")).split("\n").some((line) => {
      if (!line.trim()) return false;
      const entry = JSON.parse(line) as { tool?: string; outcome?: string };
      return entry.tool === PING_RULE && entry.outcome === "ok";
    });
  } catch {
    return false;
  }
}

export async function runnerCheck(home: string, state: InstallState | undefined, options: RunnerCheckOptions): Promise<Record<string, unknown>> {
  const workflow = options.workflow;
  const needs: Need[] = ["runner", "tools", ...(workflow ? (["skills"] as Need[]) : [])];
  const agent = state?.runtime?.profile ?? "unknown";
  const version = state?.runtime?.agent_version ?? null;
  const profile = state?.runtime?.profile ? await loadProfileById(state.runtime.profile).catch(() => null) : null;
  const at = options.now();
  if (!profile?.task) {
    for (const need of needs) await recordResult(home, { need, ...(workflow ? { workflow: workflow.id } : {}), result: "not-checked", reason: NOT_A_HOME, at, agent, agent_version: version, test: "t7" });
    return { test: "t7", passed: false, why: NOT_A_HOME };
  }
  const { challenge, word } = await startChallenge(home, { needs, test: "t7", ...(workflow ? { workflow: workflow.id } : {}), agent, agentVersion: version, ttlMs: RUN_MS + 60_000, withWord: true }, at);
  const record = await confinedPath(home, join(CHECKS_DIR, `${challenge.id}.calls.jsonl`));
  const prompt = workflow
    ? `This is a check by TaskFollow, nothing else. Call the tool check.ping with id ${challenge.id} and the TaskFollow check word given in the owner's skills below. Then answer {"done": true}.`
    : `This is a check by TaskFollow, nothing else. Call the tool check.ping with id ${challenge.id} and word ${word ?? ""}. Then answer {"done": true}.`;
  const skills = workflow ? skillsBlock([{ ref: "taskfollow-check", text: `TaskFollow check word: ${word ?? ""}` }]) : null;
  await runTask(home, profile, { prompt, input: {}, may_use: [PING_RULE], changes: false, output: OUTPUT, timeoutMs: RUN_MS, record, ...(skills ? { skills } : {}) }, { env: options.env ?? process.env });
  const after = await loadChallenge(home, challenge.id);
  const hooked = await pingUnderHook(record);
  const now = options.now();
  if (after?.status === "open") {
    await cancelChallenge(home, after, "the task did not make the test call", now);
    for (const need of needs) await recordResult(home, { need, ...(workflow ? { workflow: workflow.id } : {}), result: "not-checked", reason: "The agent's task ran but did not make the test call, so TaskFollow saw nothing", at: now, agent, agent_version: version, test: "t7", challenge: challenge.id });
    return { test: "t7", passed: false, why: "the task did not make the test call" };
  }
  if (!hooked) {
    for (const need of needs) await recordResult(home, { need, ...(workflow ? { workflow: workflow.id } : {}), result: "not-checked", reason: "The test call arrived, but not from the task under TaskFollow's hook", at: now, agent, agent_version: version, test: "t7", challenge: challenge.id });
    return { test: "t7", passed: false, why: "the test call did not come from the task" };
  }
  if (workflow && usesTool(workflow, "channel.inbox")) {
    const channels = (await listChannels(home)).filter((config) => config.channel === "email");
    for (const config of channels) await recordResult(home, { need: `reads:${config.channel}`, workflow: workflow.id, result: "yes-tested", reason: "Met by construction: on TaskFollow's own runner, the workflow reads TaskFollow's own email channel, which TaskFollow checked when it was connected", at: now, agent, agent_version: version, test: "t7" });
  }
  return { test: "t7", passed: true, why: "TaskFollow ran a real task through its runner and saw the test call under its hook" };
}
