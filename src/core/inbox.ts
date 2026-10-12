import { createHash } from "node:crypto";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { confinedPath } from "./actions.js";
import type { InboundEnvelope } from "./envelope.js";
import type { Identity } from "./members.js";
import { createRecord, listRecords } from "./numbered.js";

/**
 * Inbound messages kept under the home, one file each (§12.4): the envelope, marked untrusted, and its route.
 * `conversation`: a member wrote (Plan 8 gives conversations to the agent); `event`: anyone else wrote, the hook
 * where Plan 7's event triggers (`message.received`, §10.3) pick it up. Commands (join, reply codes, opt-out)
 * are handled by the gateway and kept with the route `command`.
 */
export const INBOX_DIR = join("data", "inbox");
export const ROUTES = ["conversation", "event", "command"] as const;
/** Who wrote first, kept as one empty file each when retention removes their messages (D102). */
export const CONTACTS_DIR = join("data", "channels", "first-contact");
export type Route = (typeof ROUTES)[number];

export type InboxItem = InboundEnvelope & {
  readonly id: number;
  readonly route: Route;
  /** The member's name when a member wrote. */
  readonly member?: string;
};

const isItem = (value: unknown): value is InboxItem =>
  typeof value === "object" && value !== null && typeof (value as InboxItem).id === "number" && typeof (value as InboxItem).channel === "string" && (value as InboxItem).untrusted === true;

/** Idempotent on the channel's message id: a message read again after a crash is kept once. */
export async function storeInbound(home: string, envelope: InboundEnvelope, route: Route, member?: string): Promise<InboxItem> {
  const stored = (await listRecords(home, INBOX_DIR, isItem)).find((item) => item.channel === envelope.channel && item.message_id === envelope.message_id);
  if (stored) return stored;
  return createRecord<InboxItem>(home, INBOX_DIR, (id) => ({ ...envelope, id, route, ...(member ? { member } : {}) }));
}

/** Newest first. */
export async function listInbox(home: string): Promise<InboxItem[]> {
  return (await listRecords(home, INBOX_DIR, isItem)).reverse();
}

const contactFile = (home: string, identity: Identity): Promise<string> =>
  confinedPath(home, join(CONTACTS_DIR, createHash("sha256").update(`${identity.channel}\n${identity.address}`).digest("hex")));

/** Called before retention removes a message (D102), so `inbound_first` consent outlives the message itself. */
export async function rememberContact(home: string, identity: Identity): Promise<void> {
  const path = await contactFile(home, identity);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await (await open(path, "wx", 0o600)).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

/** `consent: inbound_first` (D80): has this contact ever written to us on this channel? */
export async function hasWrittenFirst(home: string, identity: Identity): Promise<boolean> {
  if ((await listRecords(home, INBOX_DIR, isItem)).some((item) => item.channel === identity.channel && item.from === identity.address)) return true;
  try {
    await access(await contactFile(home, identity));
    return true;
  } catch {
    return false;
  }
}
