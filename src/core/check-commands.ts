import { serveCheckPage } from "./check-page.js";
import { abilities, loadChallenge, markChallenge, answerChallenge, startChallenge, type Need, type ResultKind } from "./checks.js";
import { runnerCheck } from "./check-runner.js";
import { decideHome } from "./homes.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";
import type { InstallState } from "./types.js";

/**
 * `taskfollow check …` (spec 5, D159): starts a check, takes the agent's answer, opens the confirmation page for a
 * person at their own terminal, and lists results. No output of a command an agent runs ever carries a page address.
 */
export const CHECK_TTL_MS = 30 * 60_000;
const SUBCOMMANDS = "start <t1|t5|t7|describe>, mark <id> <word>, answer <id> <text>, page <id>, home <workflow>, list";

export interface CheckContext {
  readonly interactive: boolean;
  readonly now: () => string;
  /** Starts the person's page process (launchCheckPage); injected so tests do not leave a page running. */
  readonly launch: (home: string, id: string, word: string | undefined) => Promise<{ pid: number; opened: boolean }>;
}

const RESULT_WORDS: Readonly<Record<ResultKind, string>> = {
  "yes-tested": "yes, tested", "yes-you-told-us": "yes, you told us", "not-checked": "not checked", "no-tested": "no, tested",
};

type Raw = Record<string, unknown>;

/** The agent being checked: the install's probed agent, or the home agent the person names (`--value '{"agent":"Claude Cowork"}'`). */
export function agentOf(state: InstallState | undefined, value: string | undefined): { agent: string; version: string | null } {
  if (value !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new InputError(`check: --value must be JSON, for example '{"agent":"Claude Cowork"}'`);
    }
    const name = typeof parsed === "object" && parsed !== null ? (parsed as Raw).agent : undefined;
    if (typeof name === "string" && name.trim() !== "") return { agent: name.trim().slice(0, 60), version: null };
  }
  if (!state?.runtime?.profile) throw new InputError("No agent was found yet: run 'taskfollow probe' first, or name the agent being checked with --value '{\"agent\":\"<its name>\"}'");
  return { agent: state.runtime.profile, version: state.runtime.agent_version ?? null };
}

const TESTS: Readonly<Record<string, { needs: readonly Need[]; instruction: (id: string, word: string) => string }>> = {
  t1: { needs: ["answers"], instruction: (id, word) => `Run: taskfollow check mark ${id} ${word}` },
  t5: { needs: ["tools"], instruction: (id, word) => `Call TaskFollow's tool check.ping with id ${id} and word ${word} (or run: taskfollow tool check.ping --value '{"id":"${id}","word":"${word}"}')` },
};

async function start(home: string, state: InstallState | undefined, test: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  if (test === "describe") return describe(home, flags, context);
  if (test === "t7") {
    const id = typeof flags.workflow === "string" ? flags.workflow : undefined;
    const workflow = id ? await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS) : undefined;
    return runnerCheck(home, state, { now: context.now, ...(workflow ? { workflow } : {}) });
  }
  const spec = test ? TESTS[test] : undefined;
  if (!spec) throw new InputError(`check start takes one of: ${[...Object.keys(TESTS), "t7", "describe"].join(", ")}`);
  const { agent, version } = agentOf(state, flags.value as string | undefined);
  // Review S4: a result names only a workflow that exists, checked the way `describe` and `t7` check it.
  const workflow = typeof flags.workflow === "string" ? (await loadWorkflow(home, requireWorkflowId(flags.workflow), DEFAULT_TOOLS)).id : undefined;
  const { challenge, word } = await startChallenge(home, { needs: spec.needs, test: test as string, ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  return { id: challenge.id, test, instruction: spec.instruction(challenge.id, word ?? ""), expires_at: challenge.expires_at };
}

/** The two questions about a described workflow, on the person's page (spec 7); the agent only learns that it opened. */
async function describe(home: string, flags: Raw, context: CheckContext): Promise<Raw> {
  const id = typeof flags.workflow === "string" ? flags.workflow : undefined;
  if (!id) throw new InputError("check start describe needs --workflow <id>");
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const { challenge } = await startChallenge(home, { needs: [], test: "describe", workflow: workflow.id, agent: "the person", agentVersion: null, ttlMs: CHECK_TTL_MS }, context.now());
  const launched = await context.launch(home, challenge.id, undefined);
  return { id: challenge.id, test: "describe", page: launched.opened ? "opened in the person's browser: ask them to answer the two questions there" : `ask the person to run 'taskfollow check page ${challenge.id}' in their own terminal` };
}

/** Where a workflow would run now, decided by code (spec 7). */
async function homeOf(home: string, state: InstallState | undefined, id: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const workflow = await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS);
  const runner = agentOf(state, undefined);
  const named = typeof flags.value === "string" ? agentOf(state, flags.value) : undefined;
  const whileAway = typeof flags.value === "string" && /"while_away"\s*:\s*true/.test(flags.value);
  const decided = await decideHome(home, workflow, { whileAway, runner: { agent: runner.agent, version: runner.version }, ...(named ? { homeAgent: { agent: named.agent, version: named.version } } : {}) }, context.now());
  return { workflow: workflow.id, home: decided.home, why: decided.why, missing: decided.missing };
}

/** The confirmation page in the person's own terminal (D61): its address is printed only there; it runs until it closes. */
async function page(home: string, id: string | undefined, context: CheckContext): Promise<Raw> {
  if (!context.interactive) throw new InputError("The check page opens only for a person, in your own terminal: run 'taskfollow check page <id>' there");
  const challenge = id ? await loadChallenge(home, id) : null;
  if (!challenge) throw new InputError(`No check '${id ?? ""}' is waiting`);
  const ttl = Math.max(60_000, Date.parse(challenge.expires_at) - Date.parse(context.now()));
  const served = await serveCheckPage(home, challenge.id, { now: context.now, ttlMs: ttl });
  process.stdout.write(`Open this page in your browser: ${served.url}/confirm\n(It stays open until the check expires; press Ctrl+C to close it sooner.)\n`);
  await served.done;
  return { status: "closed" };
}

async function list(home: string): Promise<Raw> {
  const results = (await abilities(home)).map((entry) => ({ need: entry.need, ...(entry.workflow ? { workflow: entry.workflow } : {}), result: RESULT_WORDS[entry.result], why: entry.reason, at: entry.at, agent: entry.agent, test: entry.test }));
  return { results };
}

export async function checkCommand(home: string, state: InstallState | undefined, args: readonly string[], flags: Raw, context: CheckContext): Promise<unknown> {
  const [sub, first, second] = args;
  if (sub === "start") return start(home, state, first, flags, context);
  if (sub === "mark") return markChallenge(home, first ?? "", second ?? "", { interactive: context.interactive, via: "cli", through: "mark" }, context.now()).then(view);
  if (sub === "answer") return answerChallenge(home, first ?? "", args.slice(2).join(" "), context.now()).then(view);
  if (sub === "page") return page(home, first, context);
  if (sub === "home") return homeOf(home, state, first, flags, context);
  if (sub === "list" || sub === undefined) return list(home);
  throw new InputError(`check takes: ${SUBCOMMANDS}`);
}

const view = (result: { need: string; result: ResultKind; reason: string }): Raw => ({ need: result.need, result: RESULT_WORDS[result.result], why: result.reason });
