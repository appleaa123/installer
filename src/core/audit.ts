import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { isAlive } from "./durable.js";
import { ActionFailure } from "./failure.js";
import type { AuditHead } from "./types.js";

export const AUDIT_FILE = join("audit", "audit.jsonl");
export const AUDIT_LOCK_FILE = join("audit", "audit.lock");
export const GENESIS_HASH = "0".repeat(64);
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 10_000;

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

export class AuditCorruptError extends Error {
  constructor(file: string) {
    super(`${file} has a damaged last line; it was not changed. Restore it from a copy, or start in a new home.`);
    this.name = "AuditCorruptError";
  }
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

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function parseLastRow(row: string, file: string): AuditLine {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row);
  } catch {
    throw new AuditCorruptError(file);
  }
  const { seq, hash } = (parsed ?? {}) as Partial<Record<"seq" | "hash", unknown>>;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1 || typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    throw new AuditCorruptError(file);
  }
  return parsed as AuditLine;
}

/** A lock left by a process that is gone no longer protects anything. */
async function removeStaleLock(path: string): Promise<void> {
  let pid = 0;
  try {
    pid = Number(await readFile(path, "utf8"));
  } catch {
    return;
  }
  if (Number.isInteger(pid) && pid > 0 && !isAlive(pid)) await rm(path, { force: true });
}

/** The CLI and the local MCP server append at the same time (D57): one writer at a time, through an exclusive lock file. */
async function withAuditLock<T>(home: string, task: () => Promise<T>): Promise<T> {
  const path = join(home, AUDIT_LOCK_FILE);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const until = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(String(process.pid), "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await removeStaleLock(path);
      if (Date.now() > until) throw new ActionFailure(`The audit log is locked by another installer process (${path}); if none is running, remove that file`);
      await sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return await task();
  } finally {
    await rm(path, { force: true });
  }
}

export function appendAudit(home: string, entry: AuditEntry): Promise<AuditLine> {
  return withAuditLock(home, () => appendUnlocked(home, entry));
}

async function appendUnlocked(home: string, entry: AuditEntry): Promise<AuditLine> {
  const file = join(home, AUDIT_FILE);
  const rows = await readRows(home);
  const lastRow = rows.at(-1);
  const last = lastRow === undefined ? null : parseLastRow(lastRow, file);
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
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(line)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
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
