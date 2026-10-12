/**
 * The inbound envelope (spec §12.4): every channel's message becomes `{ channel, from, thread, text, attachments,
 * received_at }`, marked untrusted and scanned for injection. A flag is information for the person and the agent;
 * nothing is ever obeyed because of a message's text (§14.2). The parsers below read only the first line a member
 * typed: a join code, a reply code (§11.9) or an opt-out keyword (§12.5).
 */
export interface RawInbound {
  readonly channel: string;
  readonly from: string;
  readonly thread: string;
  readonly text: string;
  /** The channel's own id of the message (Telegram update id, email Message-ID). */
  readonly message_id: string;
  readonly attachments?: readonly string[];
}

export interface InboundEnvelope {
  readonly channel: string;
  readonly from: string;
  readonly thread: string;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly received_at: string;
  readonly message_id: string;
  /** Always true: inbound text is data, never instructions. */
  readonly untrusted: true;
  /** Names of the injection patterns the text matched (flag, never obey). */
  readonly injection: readonly string[];
}

export const MAX_INBOUND_TEXT = 8000;
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
];

/** The names of the patterns found; `hidden_text` when the raw text carried invisible characters. */
export function scanInjection(rawText: string): readonly string[] {
  const hidden = new RegExp(HIDDEN.source).test(rawText) ? ["hidden_text"] : [];
  const visible = rawText.replace(HIDDEN, "");
  return [...hidden, ...INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name)];
}

function cleanText(text: string): string {
  const clean = text.normalize("NFC").replace(/\r\n?/g, "\n").replace(HIDDEN, "").replace(CONTROL, "").trim();
  return clean.length > MAX_INBOUND_TEXT ? clean.slice(0, MAX_INBOUND_TEXT) : clean;
}

/** One message, normalised and marked (§12.4). */
export function normalizeInbound(raw: RawInbound, receivedAt: string): InboundEnvelope {
  return {
    channel: raw.channel, from: raw.from.trim().toLowerCase(), thread: raw.thread.trim(), text: cleanText(raw.text),
    attachments: [...(raw.attachments ?? [])], received_at: receivedAt, message_id: raw.message_id, untrusted: true, injection: scanInjection(raw.text),
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
  readonly decision: "approve" | "edit" | "reject";
  readonly id: number;
  /** The new text of an edit, or the reason of a rejection. */
  readonly text: string;
}

const REPLY = /^([aer])([1-9]\d{0,8})(?=\s|$)\s*([\s\S]*)$/i;
const DECISIONS = { a: "approve", e: "edit", r: "reject" } as const;

/** §11.9 universal reply codes: `A42`, `E42 <new text>`, `R42 <reason>`. */
export function replyCodeIn(text: string): ReplyCode | null {
  const match = REPLY.exec(text.trim());
  if (!match) return null;
  const letter = (match[1] ?? "a").toLowerCase() as keyof typeof DECISIONS;
  return { decision: DECISIONS[letter], id: Number(match[2]), text: (match[3] ?? "").trim() };
}

/** The whole first line is an opt-out word (STOP, unsubscribe, a recipe's own), ignoring case and end punctuation. */
export function isOptOut(text: string, extra: readonly string[] = []): boolean {
  const line = commandLine(text).toLowerCase().replace(/[.!\s]+$/, "");
  return [...DEFAULT_OPT_OUT, ...extra.map((word) => word.trim().toLowerCase())].includes(line);
}
