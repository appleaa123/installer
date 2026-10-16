import { randomBytes } from "node:crypto";
import { join } from "node:path";
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
}
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
}

export const CHECKS_DIR = join("state", "checks");
export const ABILITIES_DIR = join("state", "abilities");
export const FRESH_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_TRIES = 2;
const ID = /^c[0-9a-f]{8}$/;

export interface Origin {
  readonly interactive: boolean;
  readonly parents: readonly string[];
}

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
}

export async function startChallenge(home: string, spec: ChallengeSpec, now: string): Promise<{ challenge: Challenge; word?: string }> {
  const id = `c${randomBytes(4).toString("hex")}`;
  const word = spec.withWord ? newWord() : undefined;
  const salt = word ? newSalt() : undefined;
  const challenge: Challenge = {
    id, needs: spec.needs, test: spec.test, ...(spec.workflow ? { workflow: spec.workflow } : {}), agent: spec.agent, agent_version: spec.agentVersion,
    ...(word && salt ? { word_salt: salt, word_hash: hashWord(word, salt) } : {}),
    created_at: now, expires_at: new Date(Date.parse(now) + spec.ttlMs).toISOString(), ...(spec.opensAt ? { opens_at: spec.opensAt } : {}), status: "open", tries: 0,
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

export const saveChallenge = (home: string, challenge: Challenge): Promise<void> => writeConfig(home, challengeFile(challenge.id), challenge);

const isResult = (value: unknown): value is StoredResult => isRecord(value) && typeof value.id === "number" && typeof value.need === "string" && typeof value.result === "string";

export async function recordResult(home: string, result: CheckResult): Promise<StoredResult> {
  const stored = await createRecord(home, ABILITIES_DIR, (id) => ({ id, ...result }));
  await appendAudit(home, { ts: result.at, actor: "engine", event: "check.result", ref: result.challenge ? `check:${result.challenge}` : `need:${result.need}`, payload: { need: result.need, result: result.result, test: result.test, workflow: result.workflow ?? null } });
  return stored;
}

export const abilities = (home: string): Promise<StoredResult[]> => listRecords(home, ABILITIES_DIR, isResult);

/** Spec 8: the newest result for this need and agent (and workflow), unless the agent's version changed or it is over 30 days old. */
export async function freshResult(home: string, need: Need, agent: string, agentVersion: string | null, now: string, workflow?: string): Promise<StoredResult | null> {
  const matching = (await abilities(home)).filter((entry) => entry.need === need && entry.agent === agent && (entry.workflow ?? null) === (workflow ?? null));
  const newest = matching.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id).at(-1);
  if (!newest) return null;
  if (newest.agent_version !== null && agentVersion !== null && newest.agent_version !== agentVersion) return null;
  if (Date.parse(now) - Date.parse(newest.at) > FRESH_DAYS * DAY_MS) return null;
  return newest;
}

async function refuse(home: string, id: string, why: string, now: string): Promise<never> {
  await appendAudit(home, { ts: now, actor: "agent", event: "check.refused", ref: `check:${id.slice(0, 16)}`, payload: { why } });
  throw new InputError(why);
}

/** The open challenge, or a refusal (audited) when it is unknown, expired, used or cancelled. */
export async function openChallenge(home: string, id: string, now: string): Promise<Challenge> {
  const challenge = await loadChallenge(home, id);
  if (!challenge) return refuse(home, id, `No check '${id}' is waiting`, now);
  if (challenge.status !== "open") return refuse(home, id, `Check '${id}' was already answered or cancelled`, now);
  if (Date.parse(now) > Date.parse(challenge.expires_at)) return refuse(home, id, `Check '${id}' expired; start it again`, now);
  return challenge;
}

async function resultsFor(home: string, challenge: Challenge, result: ResultKind, reason: string, now: string): Promise<StoredResult> {
  const stored: StoredResult[] = [];
  for (const need of challenge.needs) {
    stored.push(await recordResult(home, { need, ...(challenge.workflow ? { workflow: challenge.workflow } : {}), result, reason, at: now, agent: challenge.agent, agent_version: challenge.agent_version, test: challenge.test, challenge: challenge.id }));
  }
  return stored[0] as StoredResult;
}

/** One answer to a challenge: the right word closes it; two wrong ones cancel it. The typed text is never kept. */
export async function settleChallenge(home: string, challenge: Challenge, typed: string, interactive: boolean, now: string): Promise<StoredResult> {
  if (!challenge.word_salt || !challenge.word_hash || !verifyWord(typed, challenge.word_salt, challenge.word_hash)) {
    const tries = challenge.tries + 1;
    const cancelled = tries >= MAX_TRIES;
    await saveChallenge(home, { ...challenge, tries, ...(cancelled ? { status: "cancelled" as const } : {}) });
    return resultsFor(home, challenge, "not-checked", cancelled ? "The word did not match twice, so the test was cancelled; start it again" : "The word did not match; try once more", now);
  }
  await saveChallenge(home, { ...challenge, status: "done" });
  if (interactive) return resultsFor(home, challenge, "not-checked", "The answer came from an interactive terminal: was that you? A person typing it does not show what the agent can do", now);
  return resultsFor(home, challenge, "yes-tested", "TaskFollow saw it: the agent returned the word only this ability could give it", now);
}

export async function markChallenge(home: string, id: string, word: string, origin: Origin, now: string): Promise<StoredResult> {
  return settleChallenge(home, await openChallenge(home, id, now), word, origin.interactive, now);
}

export async function answerChallenge(home: string, id: string, text: string, now: string): Promise<StoredResult> {
  return settleChallenge(home, await openChallenge(home, id, now), text, false, now);
}
