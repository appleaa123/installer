/**
 * The inbound envelope (spec §12.4): every channel's message becomes `{ channel, from, thread, text, attachments,
 * received_at }`, marked untrusted and scanned for injection. A flag is information for the person and the agent;
 * nothing is ever obeyed because of a message's text (§14.2). The parsers below read only the first line a member
 * typed: a join code, a reply code (§11.9), an opt-out keyword (§12.5) or the kill switch (§14.4, D101).
 */
export interface RawInbound {
  readonly channel: string;
  readonly from: string;
  readonly thread: string;
  readonly text: string;
  /** The channel's own id of the message (Telegram update id, email Message-ID). */
  readonly message_id: string;
  /** Email only (D143): the subject, so a reply can stay in the same conversation. */
  readonly subject?: string;
  readonly attachments?: readonly string[];
  /** Files that came with the message, in memory only; the gateway saves them (D132). */
  readonly files?: readonly InboundFile[];
}

export interface InboundFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: Buffer;
}

export interface InboundEnvelope {
  readonly channel: string;
  readonly from: string;
  readonly thread: string;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly received_at: string;
  readonly message_id: string;
  /** Email only (D143): one line, at most 300 characters. Untrusted, like the text. */
  readonly subject?: string;
  /** Always true: inbound text is data, never instructions. */
  readonly untrusted: true;
  /** Names of the injection patterns the text matched (flag, never obey). */
  readonly injection: readonly string[];
}

export const MAX_INBOUND_TEXT = 8000;
const MAX_SUBJECT_TEXT = 300;
/** §12.5: honoured on every channel; a recipe may add its own words (`channel_policy.opt_out_keywords`). */
export const DEFAULT_OPT_OUT = ["stop", "unsubscribe"] as const;

/** Zero-width and bidirectional controls: invisible text is a classic way to hide instructions. */
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

const INJECTION_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["ignore_instructions", /\b(ignore|disregard|forget)\b[^\n]{0,40}\b(instructions?|rules|prompts?|above|previous)\b/i],
  ["role_override", /\b(you are now|act as|new instructions|from now on you)\b/i],
  ["system_prompt", /\bsystem prompt\b|<\/?\s*(system|assistant|tool)\b|\[(system|assistant)\]/i],
  ["approval_bypass", /\bapproval[_ ]token\b|\b(approve|confirm) (it|this) yourself\b|\bwithout (asking|approval)\b/i],
  ["secret_request", /\b(send|share|reveal|print|give)\b[^\n]{0,40}\b(api[_ ]?keys?|passwords?|secrets?|tokens?)\b/i],
  // Plan 10's universal injection suite (D117): a tool call written as JSON, a level change, the kill switch below
  // the first line (only a member's first line is ever read as a command) and a try to close the data fence.
  ["tool_call", /["'](tool|tool_calls?|function_call|function)["']\s*:/i],
  ["level_change", /\b(set|change|lower|raise)\b[^\n]{0,40}\blevels?\b[^\n]{0,40}\bL[0-3]\b/i],
  ["kill_switch", /(^|\s)\/(un)?pause\b/i],
  ["fence_escape", /```/],
];

/** The names of the patterns found; `hidden_text` when the raw text carried invisible characters. */
export function scanInjection(rawText: string): readonly string[] {
  const hidden = new RegExp(HIDDEN.source).test(rawText) ? ["hidden_text"] : [];
  const visible = rawText.replace(HIDDEN, "");
  return [...hidden, ...INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name)];
}

export function cleanText(text: string): string {
  const clean = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(HIDDEN, "").replace(CONTROL, "").trim();
  return clean.length > MAX_INBOUND_TEXT ? clean.slice(0, MAX_INBOUND_TEXT) : clean;
}

/** One message, normalised and marked (§12.4). */
export function normalizeInbound(raw: RawInbound, receivedAt: string): InboundEnvelope {
  return {
    channel: raw.channel, from: raw.from.trim().toLowerCase(), thread: raw.thread.trim(), text: cleanText(raw.text),
    attachments: [...(raw.attachments ?? [])], received_at: receivedAt, message_id: raw.message_id, untrusted: true, injection: scanInjection(raw.text),
    ...(raw.subject ? { subject: cleanText(raw.subject).replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_TEXT) } : {}),
  };
}

/** The first line a person typed, trimmed. */
export function commandLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

const JOIN = /^\/?(?:join|start)\s+([a-z0-9]{5})-?([a-z0-9]{5})$/i;

/** `/join ABCDE-FGHIJ`, `JOIN ABCDE-FGHIJ` or Telegram's deep link `/start ABCDEFGHIJ`, as `ABCDE-FGHIJ`. */
export function joinCodeIn(text: string): string | null {
  const match = JOIN.exec(commandLine(text));
  return match ? `${match[1]}-${match[2]}`.toUpperCase() : null;
}

export interface ReplyCode {
  readonly decision: "approve" | "edit" | "reject" | "acknowledge";
  readonly id: number;
  /** The new text of an edit, or the reason of a rejection. */
  readonly text: string;
}

const REPLY = /^([aerk])([1-9]\d{0,8})(?=\s|$)\s*([\s\S]*)$/i;
const DECISIONS = { a: "approve", e: "edit", r: "reject", k: "acknowledge" } as const;

/** §11.9 universal reply codes: `A42`, `E42 <new text>`, `R42 <reason>`; `K7` acknowledges urgent alert 7 (§11.7, D95). */
export function replyCodeIn(text: string): ReplyCode | null {
  const match = REPLY.exec(text.trim());
  if (!match) return null;
  const letter = (match[1] ?? "a").toLowerCase() as keyof typeof DECISIONS;
  return { decision: DECISIONS[letter], id: Number(match[2]), text: (match[3] ?? "").trim() };
}

const SWITCH = /^\/(pause|unpause)(?:@[A-Za-z0-9_]+)?$/i;
const BARE_SWITCH = /^\/?(pause|unpause)(?:@[A-Za-z0-9_]+)?$/i;

/**
 * `/pause` or `/unpause` as the whole first line (Telegram may add `@<bot name>`): the kill switch (§14.4, D36). On a
 * chat app that keeps `/` for its own commands (Slack, D135) the bare word `pause` or `unpause` is the whole line too.
 */
export function killSwitchIn(text: string, bare = false): "pause" | "unpause" | null {
  const match = (bare ? BARE_SWITCH : SWITCH).exec(commandLine(text));
  return match?.[1] ? (match[1].toLowerCase() as "pause" | "unpause") : null;
}

/** The whole first line is an opt-out word (STOP, unsubscribe, a recipe's own), ignoring case and end punctuation. */
export function isOptOut(text: string, extra: readonly string[] = []): boolean {
  const line = commandLine(text).toLowerCase().replace(/[.!\s]+$/, "");
  return [...DEFAULT_OPT_OUT, ...extra.map((word) => word.trim().toLowerCase())].includes(line);
}
