import { execFileSync } from "node:child_process";
import { serveCheckPage } from "./check-page.js";
import { abilities, loadChallenge, markChallenge, answerChallenge, startChallenge, type Need, type ResultKind } from "./checks.js";
import { InputError } from "./inputs.js";
import type { InstallState } from "./types.js";

/**
 * `taskfollow check …` (spec 5, D159): starts a check, takes the agent's answer, opens the confirmation page for a
 * person at their own terminal, and lists results. No output of a command an agent runs ever carries a page address.
 */
export const CHECK_TTL_MS = 30 * 60_000;
const SUBCOMMANDS = "start <t1|t5|t7>, mark <id> <word>, answer <id> <text>, page <id>, list";

export interface CheckContext {
  readonly interactive: boolean;
  readonly now: () => string;
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

/** Best effort, POSIX only: the commands above this one, to annotate a mark (spec 5.1). */
export function parentChain(pid: number = process.ppid, depth = 5): string[] {
  if (process.platform === "win32") return [];
  const chain: string[] = [];
  let current = pid;
  for (let step = 0; step < depth && current > 1; step += 1) {
    try {
      const line = execFileSync("/bin/ps", ["-o", "ppid=,comm=", "-p", String(current)], { encoding: "utf8", timeout: 2000 }).trim();
      const [ppid, ...command] = line.split(/\s+/);
      chain.push(command.join(" "));
      current = Number(ppid);
    } catch {
      break;
    }
  }
  return chain;
}

const TESTS: Readonly<Record<string, { needs: readonly Need[]; instruction: (id: string, word: string) => string }>> = {
  t1: { needs: ["answers"], instruction: (id, word) => `Run: taskfollow check mark ${id} ${word}` },
  t5: { needs: ["tools"], instruction: (id, word) => `Call TaskFollow's tool check.ping with id ${id} and word ${word} (or run: taskfollow tool check.ping --value '{"id":"${id}","word":"${word}"}')` },
};

async function start(home: string, state: InstallState | undefined, test: string | undefined, flags: Raw, context: CheckContext): Promise<Raw> {
  const spec = test ? TESTS[test] : undefined;
  if (!spec) throw new InputError(`check start takes one of: ${Object.keys(TESTS).join(", ")}`);
  const { agent, version } = agentOf(state, flags.value as string | undefined);
  const workflow = typeof flags.workflow === "string" ? flags.workflow : undefined;
  const { challenge, word } = await startChallenge(home, { needs: spec.needs, test: test as string, ...(workflow ? { workflow } : {}), agent, agentVersion: version, ttlMs: CHECK_TTL_MS, withWord: true }, context.now());
  return { id: challenge.id, test, instruction: spec.instruction(challenge.id, word ?? ""), expires_at: challenge.expires_at };
}

/** The confirmation page in the person's own terminal (D61): its address is printed only there; it runs until it closes. */
async function page(home: string, id: string | undefined, context: CheckContext): Promise<Raw> {
  if (!context.interactive) throw new InputError("The check page opens only for a person, in your own terminal: run 'taskfollow check page <id>' there");
  const challenge = id ? await loadChallenge(home, id) : null;
  if (!challenge) throw new InputError(`No check '${id ?? ""}' is waiting`);
  const ttl = Math.max(60_000, Date.parse(challenge.expires_at) - Date.parse(context.now()));
  const served = await serveCheckPage(home, challenge.id, { now: context.now, ttlMs: ttl });
  process.stdout.write(`Open this page in your browser: ${served.url}/confirm\n(It closes by itself when the check ends; press Ctrl+C to close it now.)\n`);
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
  if (sub === "mark") return markChallenge(home, first ?? "", second ?? "", { interactive: context.interactive, parents: parentChain(), via: "cli" }, context.now()).then(view);
  if (sub === "answer") return answerChallenge(home, first ?? "", args.slice(2).join(" "), context.now()).then(view);
  if (sub === "page") return page(home, first, context);
  if (sub === "list" || sub === undefined) return list(home);
  throw new InputError(`check takes: ${SUBCOMMANDS}`);
}

const view = (result: { need: string; result: ResultKind; reason: string }): Raw => ({ need: result.need, result: RESULT_WORDS[result.result], why: result.reason });
