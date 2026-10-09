import { join } from "node:path";
import type { Identity } from "./members.js";
import { createRecord, listRecords } from "./numbered.js";
import { SolutionError } from "./solution.js";

/**
 * Outbound rules for external contacts (spec §12.5, D80). The recipe declares the policy as data, the engine
 * enforces it without knowing the law: `consent` (`none`, or `inbound_first`: a contact must have written first),
 * `quiet_hours` in a named time zone, and extra opt-out words. Opt-outs (STOP, unsubscribe, the recipe's words)
 * are recorded automatically, with no approval: a risk-reducing write, logged in the audit.
 */
export const CONSENT_RULES = ["none", "inbound_first"] as const;
export type ConsentRule = (typeof CONSENT_RULES)[number];
export const OPT_OUTS_DIR = join("data", "channels", "opt-outs");

export interface QuietHours {
  readonly start: string;
  readonly end: string;
  readonly tz: string;
}

export interface ChannelPolicy {
  readonly consent: ConsentRule;
  readonly quiet_hours?: QuietHours;
  readonly opt_out_keywords: readonly string[];
}

export const DEFAULT_POLICY: ChannelPolicy = { consent: "none", opt_out_keywords: [] };

type OptOut = {
  readonly id: number;
  readonly channel: string;
  readonly address: string;
  readonly at: string;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const isOptOut = (value: unknown): value is OptOut => isRecord(value) && typeof value.id === "number" && typeof value.channel === "string" && typeof value.address === "string";

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function parseQuietHours(value: unknown): QuietHours {
  const ok = isRecord(value) && typeof value.start === "string" && TIME.test(value.start) && typeof value.end === "string" && TIME.test(value.end);
  if (!ok) throw new SolutionError('channel_policy.quiet_hours must be {"start":"HH:MM","end":"HH:MM","tz":"<IANA time zone>"}');
  if (typeof value.tz !== "string" || !validZone(value.tz)) throw new SolutionError("channel_policy.quiet_hours.tz must be an IANA time zone, for example America/Toronto");
  return { start: value.start as string, end: value.end as string, tz: value.tz };
}

/** `channel_policy` of a solution; none declared means consent `none`, no quiet hours, STOP and unsubscribe only. */
export function parseChannelPolicy(value: unknown): ChannelPolicy | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SolutionError("channel_policy must be an object");
  const consent = value.consent ?? "none";
  if (!(CONSENT_RULES as readonly unknown[]).includes(consent)) throw new SolutionError(`channel_policy.consent must be one of ${CONSENT_RULES.join(", ")}`);
  const words = value.opt_out_keywords ?? [];
  if (!Array.isArray(words) || !words.every((word) => typeof word === "string" && word.trim() !== "")) throw new SolutionError("channel_policy.opt_out_keywords must be a list of words");
  return { consent: consent as ConsentRule, opt_out_keywords: words as string[], ...(value.quiet_hours === undefined ? {} : { quiet_hours: parseQuietHours(value.quiet_hours) }) };
}

const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** True when `now` falls inside the quiet hours in their time zone; a window may cross midnight (21:00–08:00). */
export function inQuietHours(policy: ChannelPolicy, now: string): boolean {
  const quiet = policy.quiet_hours;
  if (!quiet) return false;
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
  const [at, start, end] = [minutes(local), minutes(quiet.start), minutes(quiet.end)];
  return start <= end ? at >= start && at < end : at >= start || at < end;
}

export async function isOptedOut(home: string, identity: Identity): Promise<boolean> {
  return (await listRecords(home, OPT_OUTS_DIR, isOptOut)).some((entry) => entry.channel === identity.channel && entry.address === identity.address);
}

/** Marks the contact do-not-contact; false when it already was. */
export async function recordOptOut(home: string, identity: Identity, now: string): Promise<boolean> {
  if (await isOptedOut(home, identity)) return false;
  await createRecord<OptOut>(home, OPT_OUTS_DIR, (id) => ({ id, channel: identity.channel, address: identity.address, at: now }));
  return true;
}
