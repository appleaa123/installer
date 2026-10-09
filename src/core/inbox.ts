import { join } from "node:path";
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
export type Route = (typeof ROUTES)[number];

export type InboxItem = InboundEnvelope & {
  readonly id: number;
  readonly route: Route;
  /** The member's name when a member wrote. */
  readonly member?: string;
};

const isItem = (value: unknown): value is InboxItem =>
  typeof value === "object" && value !== null && typeof (value as InboxItem).id === "number" && typeof (value as InboxItem).channel === "string" && (value as InboxItem).untrusted === true;

export function storeInbound(home: string, envelope: InboundEnvelope, route: Route, member?: string): Promise<InboxItem> {
  return createRecord<InboxItem>(home, INBOX_DIR, (id) => ({ ...envelope, id, route, ...(member ? { member } : {}) }));
}

/** Newest first. */
export async function listInbox(home: string): Promise<InboxItem[]> {
  return (await listRecords(home, INBOX_DIR, isItem)).reverse();
}

/** `consent: inbound_first` (D80): has this contact ever written to us on this channel? */
export async function hasWrittenFirst(home: string, identity: Identity): Promise<boolean> {
  return (await listRecords(home, INBOX_DIR, isItem)).some((item) => item.channel === identity.channel && item.from === identity.address);
}
