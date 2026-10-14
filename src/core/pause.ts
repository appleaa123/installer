import { join } from "node:path";
import { appendAudit } from "./audit.js";
import { CHANNEL_FACTS, requireChannelId } from "./channels.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import type { Member } from "./members.js";
import { StateCorruptError } from "./state.js";

/**
 * The kill switch (spec §14.4, D34, D36, D101). `taskfollow pause`, or `/pause` from the decision maker on a channel
 * that proves the sender, stops everything that leaves the host at once: every message goes to the recording sink
 * (`outboundBlock`), every tool call above L0 is refused, the tick starts and resumes no runs, and `taskfollow run`
 * refuses. Inbound messages are still received and kept. Stopping is always safe, so anyone may pause, the agent
 * included; unpausing sends real messages again, so it needs a person's terminal (D61) or `/unpause` from the
 * decision maker on such a channel. Every switch, and every refusal, is audited.
 */
export const PAUSE_FILE = join("config", "pause.json");
export const PAUSED_REASON = "the engine is paused (taskfollow pause or /pause): nothing goes out until a person runs 'taskfollow unpause' or the decision maker sends /unpause (D36)";
export const PAUSED_TEXT = "Paused. Messages are recorded, not sent, and no workflow runs until you send /unpause or run 'taskfollow unpause'. Incoming messages are still kept.";
export const UNPAUSED_TEXT = "Running again: messages are sent and workflows run as scheduled. Runs that fell due during the pause are recorded as missed, not run late.";

export interface PauseState {
  readonly paused: boolean;
  readonly at: string;
  readonly by: string;
  /** Where the switch came from: `cli`, or the channel of a `/pause` message. */
  readonly via: string;
  readonly reason?: string;
}

export interface Switcher {
  readonly name: string;
  readonly actor: "human" | "agent";
  readonly via: string;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export async function loadPause(home: string): Promise<PauseState | null> {
  const raw = await readConfig(home, PAUSE_FILE);
  if (raw === null) return null;
  if (!isRecord(raw) || typeof raw.paused !== "boolean" || typeof raw.at !== "string") throw new StateCorruptError(`${PAUSE_FILE} has an unexpected shape; remove it, then run 'taskfollow pause' again`);
  return raw as unknown as PauseState;
}

/** No file means the engine runs (installs before Plan 9 keep their behaviour). */
export const isPaused = async (home: string): Promise<boolean> => (await loadPause(home))?.paused === true;

export async function setPaused(home: string, paused: boolean, by: Switcher, now: string, reason?: string): Promise<PauseState> {
  const state: PauseState = { paused, at: now, by: by.name, via: by.via, ...(reason ? { reason } : {}) };
  await writeConfig(home, PAUSE_FILE, state);
  await appendAudit(home, { ts: now, actor: by.actor, event: paused ? "engine.paused" : "engine.unpaused", ref: PAUSE_FILE, payload: state });
  return state;
}

const switcher = (person: { interactive: boolean; as?: string }): Switcher =>
  person.interactive ? { name: person.as?.trim() || "terminal", actor: "human", via: "cli" } : { name: "agent", actor: "agent", via: "cli" };

/** `taskfollow pause [status] [--reason <text>]`: anyone may stop the engine; the agent's pause is audited as the agent's. */
export async function pauseCommand(home: string, sub: string | undefined, person: { interactive: boolean; as?: string }, reason: string | undefined, now: () => string): Promise<Record<string, unknown>> {
  if (sub === "status") return { pause: (await loadPause(home)) ?? { paused: false } };
  if (sub !== undefined) throw new InputError("pause takes nothing (pause now) or: status");
  const state = await setPaused(home, true, switcher(person), now(), reason);
  return { status: "paused", ...state, note: "Messages are recorded, not sent; no run starts; incoming messages are still kept. A person runs 'taskfollow unpause' in their own terminal to restart." };
}

/** `taskfollow unpause`: sends real messages and starts runs again, so only a person, in their own terminal (D61). */
export async function unpauseCommand(home: string, person: { interactive: boolean; as?: string }, now: () => string): Promise<Record<string, unknown>> {
  if (!person.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "engine.unpause_refused", ref: PAUSE_FILE, payload: { command: "taskfollow unpause" } });
    throw new InputError("Unpausing sends real messages and starts runs again: the person runs 'taskfollow unpause' in their own terminal, or the decision maker sends /unpause in Telegram");
  }
  if (!(await isPaused(home))) return { status: "running", note: "The engine was not paused" };
  return { status: "unpaused", ...(await setPaused(home, false, switcher(person), now())) };
}

/**
 * Why a `/pause` or `/unpause` message decides nothing, or null when it may: only the decision maker (D26, D60), and
 * only on a channel that proves who wrote (D78: Telegram, not email).
 */
export function switchRefusal(member: Member, channel: string, command: "pause" | "unpause"): string | null {
  if (!CHANNEL_FACTS[requireChannelId(channel)].risk.sender_verified) return `/${command} is not accepted by ${channel}, where the sender can be forged: send it in Telegram, or run 'installer ${command}' in a terminal`;
  if (member.role !== "decision_maker") return `Only the decision maker can send /${command}; nothing was changed`;
  return null;
}
