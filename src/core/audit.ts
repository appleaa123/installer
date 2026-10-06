import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AuditHead } from "./types.js";

export const AUDIT_FILE = join("audit", "audit.jsonl");
export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  readonly ts: string;
  readonly actor: "human" | "agent" | "engine";
  readonly event: string;
  readonly ref: string;
  readonly payload: unknown;
}

export interface AuditLine {
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly event: string;
  readonly ref: string;
  readonly payload_fingerprint: string;
  readonly prev_hash: string;
  readonly hash: string;
}

export type AuditCheck = { readonly ok: true; readonly lines: number } | { readonly ok: false; readonly line: number; readonly reason: string };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

function hashBody(body: Omit<AuditLine, "hash">): string {
  return sha256(body.prev_hash + canonicalJson(body));
}

async function readRows(home: string): Promise<string[]> {
  try {
    return (await readFile(join(home, AUDIT_FILE), "utf8")).split("\n").filter((row) => row.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendAudit(home: string, entry: AuditEntry): Promise<AuditLine> {
  const rows = await readRows(home);
  const lastRow = rows.at(-1);
  const last = lastRow === undefined ? null : (JSON.parse(lastRow) as AuditLine);
  const body = {
    seq: (last?.seq ?? 0) + 1,
    ts: entry.ts,
    actor: entry.actor,
    event: entry.event,
    ref: entry.ref,
    payload_fingerprint: sha256(canonicalJson(entry.payload)),
    prev_hash: last?.hash ?? GENESIS_HASH,
  };
  const line: AuditLine = { ...body, hash: hashBody(body) };
  const file = join(home, AUDIT_FILE);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, `${JSON.stringify(line)}\n`, { encoding: "utf8", mode: 0o600 });
  return line;
}

export async function verifyAudit(home: string, head?: AuditHead): Promise<AuditCheck> {
  const rows = await readRows(home);
  const parsed: AuditLine[] = [];
  let previous = GENESIS_HASH;
  for (const [index, row] of rows.entries()) {
    const line = index + 1;
    let item: AuditLine;
    try {
      item = JSON.parse(row) as AuditLine;
    } catch {
      return { ok: false, line, reason: "not valid JSON" };
    }
    const { hash, ...body } = item;
    if (body.seq !== line) return { ok: false, line, reason: "sequence gap" };
    if (body.prev_hash !== previous) return { ok: false, line, reason: "previous-hash mismatch" };
    if (hashBody(body) !== hash) return { ok: false, line, reason: "hash mismatch" };
    parsed.push(item);
    previous = hash;
  }
  if (head && parsed[head.seq - 1]?.hash !== head.hash) {
    return { ok: false, line: head.seq, reason: "recorded head not found (lines removed?)" };
  }
  return { ok: true, lines: rows.length };
}
