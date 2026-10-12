import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { deciderFor } from "./approvals.js";
import { appendAudit } from "./audit.js";
import { InputError } from "./inputs.js";
import { ROLES, type Role } from "./levels.js";
import { claimOnce, createRecord, listRecords, replaceRecord } from "./numbered.js";
import type { Roles } from "./types.js";

/**
 * Sender identity (spec §11.9, D77): `installer invite <name>` creates a member with a one-time join code; the person
 * sends it to a channel (`/join CODE`, or the bot's start link, or an email whose first line is `JOIN CODE`), and the
 * gateway binds that channel identity to the member and its role. Only the code's sha256 is stored; a code is used
 * once (an exclusive claim) and expires after 72 hours. One record per invite, so a person on two channels is two
 * records with the same name. The role comes from the name, as at the terminal (D60).
 */
export const MEMBERS_DIR = join("state", "members");
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const MEMBER_STATUSES = ["invited", "joined", "expired", "removed"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];
/** No 0/O or 1/I: a code is read off a screen and typed on a phone. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_NAME = 80;

export interface Identity {
  readonly channel: string;
  readonly address: string;
}

export type Member = {
  readonly id: number;
  readonly name: string;
  readonly role: Role;
  readonly code_hash: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly status: MemberStatus;
  readonly identity?: Identity;
  readonly joined_at?: string;
};

export type JoinResult = { readonly joined: Member } | { readonly refused: string };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isMember(value: unknown): value is Member {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.name !== "string" || typeof value.code_hash !== "string") return false;
  return (ROLES as readonly unknown[]).includes(value.role) && (MEMBER_STATUSES as readonly unknown[]).includes(value.status) && typeof value.expires_at === "string";
}

/** Ten characters in two groups, `ABCDE-FGHJK`. */
export function newJoinCode(): string {
  const chars = [...randomBytes(10)].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export function requireMemberName(name: string | undefined): string {
  const trimmed = name?.trim() ?? "";
  if (trimmed === "" || trimmed.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new InputError(`invite needs the person's name (1 to ${MAX_NAME} characters), for example: installer invite "Ada Lovelace"`);
  return trimmed;
}

const audit = (home: string, now: string, actor: "human" | "engine", event: string, member: Member, extra: Record<string, unknown> = {}) =>
  appendAudit(home, { ts: now, actor, event, ref: `member:${member.id}`, payload: { id: member.id, name: member.name, role: member.role, ...extra } });

export async function createInvite(home: string, name: string, roles: Roles | undefined, now: string): Promise<{ member: Member; code: string }> {
  const code = newJoinCode();
  const role = deciderFor(name, roles).role;
  const member = await createRecord<Member>(home, MEMBERS_DIR, (id) => ({
    id, name, role, code_hash: sha256(code), created_at: now, expires_at: new Date(Date.parse(now) + INVITE_TTL_MS).toISOString(), status: "invited",
  }));
  await audit(home, now, "human", "member.invited", member);
  return { member, code };
}

/** Every member, an unused invite past its 72 hours turned `expired` (lazy, like approvals, D62). */
export async function listMembers(home: string, now: string): Promise<Member[]> {
  const members: Member[] = [];
  for (const member of await listRecords(home, MEMBERS_DIR, isMember)) {
    const overdue = member.status === "invited" && Date.parse(now) >= Date.parse(member.expires_at);
    if (!overdue) {
      members.push(member);
      continue;
    }
    const expired: Member = { ...member, status: "expired" };
    await replaceRecord(home, MEMBERS_DIR, expired);
    await audit(home, now, "engine", "member.expired", expired);
    members.push(expired);
  }
  return members;
}

const sameIdentity = (a: Identity | undefined, b: Identity): boolean => a !== undefined && a.channel === b.channel && a.address === b.address;

/** The joined member this channel identity belongs to, or null (an unknown sender). */
export async function memberFor(home: string, identity: Identity, now: string): Promise<Member | null> {
  return (await listMembers(home, now)).find((member) => member.status === "joined" && sameIdentity(member.identity, identity)) ?? null;
}

/** Binds the sender to the invite whose code this is: once, before it expires, and only an identity not yet bound. */
export async function joinWithCode(home: string, code: string, identity: Identity, now: string): Promise<JoinResult> {
  const members = await listMembers(home, now);
  const invite = members.find((member) => member.status === "invited" && member.code_hash === sha256(code));
  const refused = async (reason: string): Promise<JoinResult> => {
    await appendAudit(home, { ts: now, actor: "engine", event: "member.join_refused", ref: identity.channel, payload: { reason, identity } });
    return { refused: reason };
  };
  if (!invite) return refused("This join code is not valid: it was mistyped, already used or expired. Ask for a new invite.");
  if (members.some((member) => member.status === "joined" && sameIdentity(member.identity, identity))) return refused(`This ${identity.channel} account has already joined.`);
  if (!(await claimOnce(home, MEMBERS_DIR, invite.id))) return refused("This join code was already used. Ask for a new invite.");
  const joined: Member = { ...invite, status: "joined", identity, joined_at: now };
  await replaceRecord(home, MEMBERS_DIR, joined);
  await audit(home, now, "engine", "member.joined", joined, { channel: identity.channel });
  return { joined };
}

/** `installer members remove <id>`: the member can no longer decide anything from a channel. */
export async function removeMember(home: string, id: number, now: string): Promise<Member> {
  const member = (await listMembers(home, now)).find((entry) => entry.id === id);
  if (!member) throw new InputError(`No member ${id}`);
  const removed: Member = { ...member, status: "removed" };
  await replaceRecord(home, MEMBERS_DIR, removed);
  await audit(home, now, "human", "member.removed", removed);
  return removed;
}
