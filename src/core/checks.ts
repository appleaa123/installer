import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { createRecord, listRecords, type NumberedRecord } from "./numbered.js";
import { hashWord, newSalt, newWord, verifyWord } from "./words.js";

/**
 * The doability check's core (spec v3.1 sections 3, 5.1, 8; D159). A challenge is kept on disk with the word's slow
 * salted hash only; the agent can only answer it (`check mark`, `check answer`, `check.ping`), once. Every result is
 * its own numbered record (three processes write them: the CLI, the check page, the MCP server) and an audit entry;
 * neither ever holds the text an agent typed.
 */
export type Need = "answers" | `reads:${string}` | `writes:${string}` | "skills" | "tools" | "runner" | "scheduler" | "asks-first" | "hooks";
export type ResultKind = "yes-tested" | "yes-you-told-us" | "not-checked" | "no-tested";
export type ChallengeStatus = "open" | "done" | "cancelled";

export interface CheckResult {
  readonly need: Need;
  readonly workflow?: string;
  readonly result: ResultKind;
  /** Plain words for the person: how TaskFollow knows, or why it does not. */
  readonly reason: string;
  readonly at: string;
  readonly agent: string;
  readonly agent_version: string | null;
  readonly test: string;
  readonly challenge?: string;
  /** How the agent reached TaskFollow: its MCP connection or the `taskfollow` command (T5). */
  readonly via?: string;
  /** What carried the word back: the tool `check.ping`, the command `check mark`, or `check answer` (review B2). */
  readonly through?: Through;
  /** T8 only: whether it ran while the person was away (around the set time, window closed), not "well after" (review H2). */
  readonly while_away?: boolean;
}
export type Through = "ping" | "mark" | "answer" | "read-back";
export type StoredResult = CheckResult & NumberedRecord;

export interface Challenge {
  readonly id: string;
  readonly needs: readonly Need[];
  readonly test: string;
  readonly workflow?: string;
  readonly agent: string;
  readonly agent_version: string | null;
  readonly word_salt?: string;
  readonly word_hash?: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly opens_at?: string;
  readonly shown_at?: string;
  readonly status: ChallengeStatus;
  readonly tries: number;
  /** Plain facts a page shows (an instruction, a file to upload, a scheduled time); never a word. */
  readonly details?: Readonly<Record<string, string>>;
}

export const CHECKS_DIR = join("state", "checks");
export const ABILITIES_DIR = join("state", "abilities");
export const FRESH_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_TRIES = 2;
const ID = /^c[0-9a-f]{8}$/;

/** Who sent a mark: an interactive terminal is labelled "was that you?" (D61's check); nothing else is inferred. */
export interface Origin {
  readonly interactive: boolean;
  readonly via?: string;
  readonly through?: Through;
}

/** Tests that prove TaskFollow's own tools: the word counts only when it came back through the tool (review B2). */
const TOOL_TESTS: readonly string[] = ["t5", "t7"];

const challengeFile = (id: string): string => join(CHECKS_DIR, `${id}.json`);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export interface ChallengeSpec {
  readonly needs: readonly Need[];
  readonly test: string;
  readonly workflow?: string;
  readonly agent: string;
  readonly agentVersion: string | null;
  readonly ttlMs: number;
  readonly opensAt?: string;
  /** Make a word; it is returned to the in-process caller only (to put on the person's page, or plant). */
  readonly withWord?: boolean;
  /** A ready word (for example two parts, one of which lives in a test skill); hashed like any other. */
  readonly word?: string;
  readonly details?: Readonly<Record<string, string>>;
}

export async function startChallenge(home: string, spec: ChallengeSpec, now: string): Promise<{ challenge: Challenge; word?: string }> {
  const id = `c${randomBytes(4).toString("hex")}`;
  const word = spec.word ?? (spec.withWord ? newWord() : undefined);
  const salt = word ? newSalt() : undefined;
  const challenge: Challenge = {
    id, needs: spec.needs, test: spec.test, ...(spec.workflow ? { workflow: spec.workflow } : {}), agent: spec.agent, agent_version: spec.agentVersion,
    ...(word && salt ? { word_salt: salt, word_hash: hashWord(word, salt) } : {}),
    created_at: now, expires_at: new Date(Date.parse(now) + spec.ttlMs).toISOString(), ...(spec.opensAt ? { opens_at: spec.opensAt } : {}), status: "open", tries: 0, ...(spec.details ? { details: spec.details } : {}),
  };
  await writeConfig(home, challengeFile(id), challenge);
  await appendAudit(home, { ts: now, actor: "engine", event: "check.started", ref: `check:${id}`, payload: { test: spec.test, needs: spec.needs, workflow: spec.workflow ?? null } });
  return { challenge, ...(word ? { word } : {}) };
}

export async function loadChallenge(home: string, id: string): Promise<Challenge | null> {
  if (!ID.test(id)) return null;
  const raw = await readConfig(home, challengeFile(id));
  return isRecord(raw) && raw.id === id ? (raw as unknown as Challenge) : null;
}

/**
 * Item 7: files and skill folders a test made are listed in its challenge (`details.file`, `details.skill_dir`) and
 * removed once it is answered, cancelled or expired. Only paths inside a `taskfollow-check` folder or named
 * `taskfollow-check-…` are ever removed, whatever the challenge file says.
 */
export async function removeArtifacts(challenge: Challenge): Promise<void> {
  for (const path of [challenge.details?.file, challenge.details?.skill_dir]) {
    if (!path) continue;
    const ours = basename(dirname(path)) === "taskfollow-check" || basename(path).startsWith("taskfollow-check-");
    if (ours) await rm(path, { recursive: true, force: true });
  }
}

export async function saveChallenge(home: string, challenge: Challenge): Promise<void> {
  await writeConfig(home, challengeFile(challenge.id), challenge);
  if (challenge.status !== "open") await removeArtifacts(challenge);
}

const isResult = (value: unknown): value is StoredResult => isRecord(value) && typeof value.id === "number" && typeof value.need === "string" && typeof value.result === "string";

export async function recordResult(home: string, result: CheckResult): Promise<StoredResult> {
  const stored = await createRecord(home, ABILITIES_DIR, (id) => ({ id, ...result }));
  await appendAudit(home, { ts: result.at, actor: "engine", event: "check.result", ref: result.challenge ? `check:${result.challenge}` : `need:${result.need}`, payload: { need: result.need, result: result.result, test: result.test, workflow: result.workflow ?? null } });
  return stored;
}

export const abilities = (home: string): Promise<StoredResult[]> => listRecords(home, ABILITIES_DIR, isResult);

/** Spec 8: the newest result for this need and agent (and workflow), unless the agent's version changed or it is over 30 days old. */
export async function freshResult(home: string, need: Need, agent: string, agentVersion: string | null, now: string, workflow?: string, exceptTests: readonly string[] = []): Promise<StoredResult | null> {
  const matching = (await abilities(home)).filter((entry) => entry.need === need && entry.agent === agent && (entry.workflow ?? null) === (workflow ?? null) && !exceptTests.includes(entry.test));
  const newest = matching.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id).at(-1);
  if (!newest) return null;
  if (newest.agent_version !== null && agentVersion !== null && newest.agent_version !== agentVersion) return null;
  if (Date.parse(now) - Date.parse(newest.at) > FRESH_DAYS * DAY_MS) return null;
  return newest;
}

type Actor = "agent" | "human";

async function refuse(home: string, id: string, why: string, now: string, actor: Actor): Promise<never> {
  await appendAudit(home, { ts: now, actor, event: "check.refused", ref: `check:${id.slice(0, 16)}`, payload: { why } });
  throw new InputError(why);
}

/** The open challenge, or a refusal (audited, as whoever asked: the agent, or the person on their page) when it is unknown, expired, used or cancelled. */
export async function openChallenge(home: string, id: string, now: string, actor: Actor = "agent"): Promise<Challenge> {
  const challenge = await loadChallenge(home, id);
  if (!challenge) return refuse(home, id, `No check '${id}' is waiting`, now, actor);
  if (challenge.status !== "open") return refuse(home, id, `Check '${id}' was already answered or cancelled`, now, actor);
  if (Date.parse(now) > Date.parse(challenge.expires_at)) return refuse(home, id, `Check '${id}' expired; start it again`, now, actor);
  return challenge;
}

async function resultsFor(home: string, challenge: Challenge, result: ResultKind, reason: string, now: string, via?: string, through?: Through): Promise<StoredResult> {
  const stored: StoredResult[] = [];
  for (const need of challenge.needs) {
    stored.push(await recordResult(home, { need, ...(challenge.workflow ? { workflow: challenge.workflow } : {}), result, reason, at: now, agent: challenge.agent, agent_version: challenge.agent_version, test: challenge.test, challenge: challenge.id, ...(via ? { via } : {}), ...(through ? { through } : {}) }));
  }
  return stored[0] as StoredResult;
}

/** One answer to a challenge: the right word closes it; two wrong ones cancel it. The typed text is never kept. */
/** Who answered: the agent from its shell, someone at an interactive terminal, or the person on their check page. */
export type Answerer = "agent" | "terminal" | "person";

/** Writing tests (T3): what counts is what TaskFollow reads back from the target, never a word sent back. */
const READ_BACK: readonly string[] = ["t3f", "t3r"];

/** Tests of what the agent itself can do: the word was given to the agent, so a person typing it proves nothing (review S2). */
const AGENT_TESTS: readonly string[] = ["t1", "t5", "t7", "t3f", "t3r", "t4"];

/** A refusal that records nothing and leaves the challenge open with its tries untouched. */
const stillOpen = (challenge: Challenge, reason: string, now: string): StoredResult => ({ id: 0, need: challenge.needs[0] ?? "answers", result: "not-checked", reason, at: now, agent: challenge.agent, agent_version: challenge.agent_version, test: challenge.test, challenge: challenge.id });

/** T8 from the agent's side (review B1): only a mark from a scheduler on this computer, after the window closed, can count. */
function scheduleRefusal(challenge: Challenge, through: Through | undefined): string | null {
  if (through !== "mark") return "check answer and check.ping never settle a schedule check: the person confirms what arrived on their page";
  if (!challenge.details?.closed_at) return "Not yet: the person must close the assistant's window on their page first (that is when the test email is planted)";
  if (challenge.details.local_scheduler !== "yes") return "This assistant's schedule runs in the cloud, so a command on this computer did not come from it; confirm on your page";
  return null;
}

export async function settleChallenge(home: string, challenge: Challenge, typed: string, answerer: Answerer, now: string, via?: string, through?: Through): Promise<StoredResult> {
  if (answerer === "person" && AGENT_TESTS.includes(challenge.test)) {
    return stillOpen(challenge, "This test checks what your agent can do, so the word must come back from your agent, not from you; the check stays open", now);
  }
  if (READ_BACK.includes(challenge.test) && through !== "read-back") {
    return stillOpen(challenge, "TaskFollow reads what was written itself: write it, then run 'taskfollow check answer <id> done'", now);
  }
  if (challenge.test === "t8" && answerer === "agent") {
    const refusal = scheduleRefusal(challenge, through);
    if (refusal) return stillOpen(challenge, refusal, now);
  }
  if (!challenge.word_salt || !challenge.word_hash || !verifyWord(typed, challenge.word_salt, challenge.word_hash)) {
    const tries = challenge.tries + 1;
    const cancelled = tries >= MAX_TRIES;
    await saveChallenge(home, { ...challenge, tries, ...(cancelled ? { status: "cancelled" as const } : {}) });
    return resultsFor(home, challenge, "not-checked", cancelled ? "The word did not match twice, so the test was cancelled; start it again" : "The word did not match; try once more", now);
  }
  // T8 (spec 5.2): a mark from a job on this computer counts only at or after the scheduled time; before it, it was not the scheduler.
  if (challenge.test === "t8" && answerer === "agent" && challenge.opens_at && now < challenge.opens_at) {
    await saveChallenge(home, { ...challenge, status: "cancelled" });
    return resultsFor(home, challenge, "not-checked", "It ran before the scheduled time, so it was not the agent's scheduler; start the check again", now, via, through);
  }
  await saveChallenge(home, { ...challenge, status: "done" });
  if (answerer === "terminal") return resultsFor(home, challenge, "not-checked", "The answer came from an interactive terminal: was that you? A person typing it does not show what the agent can do", now);
  if (answerer === "person") return resultsFor(home, challenge, "yes-you-told-us", "You told us: you typed the word you received", now);
  if (TOOL_TESTS.includes(challenge.test) && through !== "ping") return resultsFor(home, challenge, "not-checked", "The word came by command, not through the tool, so it does not show that the agent can reach TaskFollow's tools", now, via, through);
  if (challenge.test === "t8") return resultsFor(home, challenge, "yes-you-told-us", "A job on this computer marked it at or after the set time; whether that was the assistant's scheduler or a detached command, TaskFollow cannot tell", now, via, through);
  if (challenge.test === "t4") return resultsFor(home, challenge, "yes-tested", "The skill's text reached the agent: it gave the word only the test skill held. Whether through its skill system or by reading the file, TaskFollow cannot tell", now, via, through);
  if (READ_BACK.includes(challenge.test)) return resultsFor(home, challenge, "yes-tested", "TaskFollow saw it: it read the word back from the place it named. Writing never decides where a workflow runs", now, via, through);
  return resultsFor(home, challenge, "yes-tested", "TaskFollow saw it: the agent returned the word only this ability could give it", now, via, through);
}

export async function markChallenge(home: string, id: string, word: string, origin: Origin, now: string): Promise<StoredResult> {
  return settleChallenge(home, await openChallenge(home, id, now), word, origin.interactive ? "terminal" : "agent", now, origin.via, origin.through ?? "mark");
}

/** Review M6: an answer typed at an interactive terminal is labelled "was that you?", as a mark is. */
export async function answerChallenge(home: string, id: string, text: string, now: string, origin: { readonly interactive: boolean } = { interactive: false }): Promise<StoredResult> {
  return settleChallenge(home, await openChallenge(home, id, now), text, origin.interactive ? "terminal" : "agent", now, undefined, "answer");
}

/** Ends a challenge without a result (the word was shown twice, or the person cancelled), with an audit entry. */
export async function cancelChallenge(home: string, challenge: Challenge, why: string, now: string): Promise<void> {
  await saveChallenge(home, { ...challenge, status: "cancelled" });
  await appendAudit(home, { ts: now, actor: "engine", event: "check.cancelled", ref: `check:${challenge.id}`, payload: { why } });
}

/** The newest result per need for one agent, across workflows' agent-wide checks only (for the report). */
export async function latestByNeed(home: string, agent: string): Promise<{ need: Need; result: ResultKind; at: string }[]> {
  const newest = new Map<string, StoredResult>();
  for (const entry of (await abilities(home)).filter((result) => result.agent === agent && result.workflow === undefined)) {
    const seen = newest.get(entry.need);
    if (!seen || seen.at < entry.at || (seen.at === entry.at && seen.id < entry.id)) newest.set(entry.need, entry);
  }
  return [...newest.values()].map((entry) => ({ need: entry.need, result: entry.result, at: entry.at }));
}

/** A person's answer that is not a word (the work done once, the scheduled job's outcome): one result per need, then done. */
export async function settleByPerson(home: string, challenge: Challenge, outcomes: readonly { readonly need: Need; readonly result: ResultKind; readonly reason: string; readonly while_away?: boolean }[], now: string): Promise<void> {
  await saveChallenge(home, { ...challenge, status: "done" });
  for (const outcome of outcomes) {
    await recordResult(home, { need: outcome.need, ...(challenge.workflow ? { workflow: challenge.workflow } : {}), result: outcome.result, reason: outcome.reason, at: now, agent: challenge.agent, agent_version: challenge.agent_version, test: challenge.test, challenge: challenge.id, through: "answer", ...(outcome.while_away === undefined ? {} : { while_away: outcome.while_away }) });
  }
}
