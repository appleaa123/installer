import { serveCheckPage } from "./check-page.js";
import { abilities, loadChallenge, markChallenge, answerChallenge, startChallenge, type Need, type ResultKind } from "./checks.js";
import { runnerCheck } from "./check-runner.js";
import { decideHome } from "./homes.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { loadWorkflow, requireWorkflowId } from "./workflow.js";
import type { InstallState } from "./types.js";
import type { OutboundFile } from "./channels.js";
import type { SheetTarget } from "./check-reads.js";

/**
 * `taskfollow check …` (spec 5, D159): starts a check, takes the agent's answer, opens the confirmation page for a
 * person at their own terminal, and lists results. No output of a command an agent runs ever carries a page address.
 */
export const CHECK_TTL_MS = 30 * 60_000;
const SUBCOMMANDS = "start <t1|t2|t2a|t2f|t2r|t3f|t3r|t4|t5|t6|t6b|t7|t8|t11|describe>, once <workflow>, mark <id> <word>, answer <id> <text>, cannot <id>, page <id>, home <workflow>, deliver <workflow>, summary <workflow>, missed <workflow>, list";

export interface CheckContext {
  readonly interactive: boolean;
  readonly now: () => string;
  /** Starts the person's page process (launchCheckPage); injected so tests do not leave a page running. */
  readonly launch: (home: string, id: string, word: string | undefined) => Promise<{ pid: number; opened: boolean }>;
  /** Plants a self-addressed test email through TaskFollow's own email channel; false when it has none (tests inject it). */
  readonly plant?: (home: string, subject: string, text: string, files?: readonly OutboundFile[]) => Promise<boolean>;
  /** Whether TaskFollow could plant a test email (it has its own email channel); decided before the person closes the window. */
  readonly canPlant?: (home: string) => Promise<boolean>;
  /** TaskFollow's own connected spreadsheet (records tests); tests inject a fake; null when none is connected. */
  readonly sheets?: (home: string) => Promise<SheetTarget | null>;
  /** Runs the agent's `asks` command (T6b) and returns its standard output; tests inject it. */
  readonly asks?: (argv: readonly string[], cwd: string) => Promise<string>;
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
  if (test === "t8") return (await import("./check-schedule.js")).startScheduled(home, state, flags, context);
  if (test === "t2") return (await import("./check-email.js")).startReadsEmail(home, state, flags, context);
  if (test === "t2f") return (await import("./check-reads.js")).startReadsFiles(home, state, flags, context);
  if (test === "t2a") return (await import("./check-reads.js")).startReadsAttachment(home, state, flags, context);
  if (test === "t2r") return (await import("./check-reads.js")).startReadsRecords(home, state, flags, context);
  if (test === "t3f") return (await import("./check-write.js")).startWritesFiles(home, state, flags, context);
  if (test === "t3r") return (await import("./check-write.js")).startWritesRecords(home, state, flags, context);
  if (test === "t4") return (await import("./check-skill.js")).startSkillCheck(home, state, flags, context);
  if (test === "t6") return (await import("./check-asks.js")).startAsks(home, state, flags, context);
  if (test === "t6b") return (await import("./check-asks.js")).startAsksUnattended(home, state, flags, context);
  if (test === "t11") return (await import("./check-runner.js")).hooksCheck(home, state, { now: context.now });
  if (test === "t7") {
    const id = typeof flags.workflow === "string" ? flags.workflow : undefined;
    const workflow = id ? await loadWorkflow(home, requireWorkflowId(id), DEFAULT_TOOLS) : undefined;
    return runnerCheck(home, state, { now: context.now, ...(workflow ? { workflow } : {}) });
  }
  const spec = test ? TESTS[test] : undefined;
  if (!spec) throw new InputError("check start takes one of: t1, t2, t2a, t2f, t2r, t3f, t3r, t4, t5, t6, t6b, t7, t8, t11, describe");
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
  if (sub === "mark") {
    const marked = await markChallenge(home, first ?? "", second ?? "", { interactive: context.interactive, via: "cli", through: "mark" }, context.now());
    await (await import("./check-reads.js")).removeTab(home, first ?? "", context);
    return view(marked);
  }
  if (sub === "answer") {
    const write = await import("./check-write.js");
    const answered = (await write.isReadBack(home, first ?? "")) && !context.interactive
      ? await write.answerByReadBack(home, first ?? "", context)
      : await answerChallenge(home, first ?? "", args.slice(2).join(" "), context.now(), { interactive: context.interactive });
    await (await import("./check-reads.js")).removeTab(home, first ?? "", context);
    return view(answered);
  }
  if (sub === "page") return page(home, first, context);
  if (sub === "cannot") return (await import("./check-email.js")).cannotCommand(home, first, context.now());
  if (sub === "deliver") {
    const workflow = await loadWorkflow(home, requireWorkflowId(first), DEFAULT_TOOLS);
    if (typeof flags.value !== "string" || !/"agent"/.test(flags.value)) throw new InputError(`check deliver needs the assistant whose schedule would run it: --value '{"agent":"Claude Cowork"}'`);
    const target = agentOf(state, flags.value);
    const runner = state?.runtime?.profile ? agentOf(state, undefined) : { agent: "no runner agent", version: null };
    return (await import("./deliver.js")).deliverToCowork(home, workflow, { now: context.now(), agent: { agent: target.agent, version: target.version }, runner: { agent: runner.agent, version: runner.version } });
  }
  if (sub === "missed") return (await import("./check-summary.js")).missedCommand(home, state, first, flags, context);
  if (sub === "summary") return (await import("./check-summary.js")).summaryCommand(home, state, first, flags, context);
  if (sub === "once") return (await import("./check-once.js")).onceCommand(home, state, first, flags, context);
  if (sub === "home") return homeOf(home, state, first, flags, context);
  if (sub === "list" || sub === undefined) return list(home);
  throw new InputError(`check takes: ${SUBCOMMANDS}`);
}

const view = (result: { need: string; result: ResultKind; reason: string }): Raw => ({ need: result.need, result: RESULT_WORDS[result.result], why: result.reason });
