import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE, GENESIS_HASH, appendAudit, canonicalJson, verifyAudit, type AuditEntry } from "../../src/core/audit.js";
import { makeTempHome } from "../helpers/temp-home.js";

const entry = (event: string, payload: unknown = { n: 1 }): AuditEntry => ({
  ts: "2026-01-01T00:00:00.000Z",
  actor: "engine",
  event,
  ref: "step.x",
  payload,
});

async function lines(home: string): Promise<string[]> {
  return (await readFile(join(home, AUDIT_FILE), "utf8")).split("\n").filter(Boolean);
}

async function rewrite(home: string, rows: string[]): Promise<void> {
  await writeFile(join(home, AUDIT_FILE), `${rows.join("\n")}\n`, "utf8");
}

describe("canonicalJson", () => {
  it("is independent of key order and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] }, z: undefined })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
});

describe("audit trail", () => {
  it("chains lines from the genesis hash", async () => {
    const home = await makeTempHome();
    const first = await appendAudit(home, entry("one"));
    const second = await appendAudit(home, entry("two"));
    expect(first.seq).toBe(1);
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(second.prev_hash).toBe(first.hash);
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 2 });
  });

  it("stores a fingerprint, never the raw payload", async () => {
    const home = await makeTempHome();
    await appendAudit(home, entry("one", { name: "private value" }));
    const [raw] = await lines(home);
    expect(raw).not.toContain("private value");
    expect(JSON.parse(raw ?? "{}").payload_fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects an edited line", async () => {
    const home = await makeTempHome();
    for (const name of ["one", "two", "three"]) await appendAudit(home, entry(name));
    const rows = await lines(home);
    await rewrite(home, rows.map((row, i) => (i === 1 ? row.replace('"two"', '"TWO"') : row)));
    await expect(verifyAudit(home)).resolves.toEqual({ ok: false, line: 2, reason: "hash mismatch" });
  });

  it("detects a deleted middle line and reordered lines", async () => {
    const home = await makeTempHome();
    for (const name of ["one", "two", "three"]) await appendAudit(home, entry(name));
    const rows = await lines(home);
    await rewrite(home, [rows[0] ?? "", rows[2] ?? ""]);
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: false, line: 2 });
    await rewrite(home, [rows[1] ?? "", rows[0] ?? "", rows[2] ?? ""]);
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: false, line: 1 });
  });

  it("detects truncation when the recorded head is given", async () => {
    const home = await makeTempHome();
    await appendAudit(home, entry("one"));
    const last = await appendAudit(home, entry("two"));
    const rows = await lines(home);
    await rewrite(home, [rows[0] ?? ""]);
    await expect(verifyAudit(home, { seq: last.seq, hash: last.hash })).resolves.toMatchObject({ ok: false, line: 2 });
  });

  it("accepts lines beyond the recorded head (crash between audit and save)", async () => {
    const home = await makeTempHome();
    const first = await appendAudit(home, entry("one"));
    await appendAudit(home, entry("two"));
    await expect(verifyAudit(home, { seq: first.seq, hash: first.hash })).resolves.toEqual({ ok: true, lines: 2 });
  });

  it("treats a missing audit file as an empty, valid chain", async () => {
    const home = await makeTempHome();
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 0 });
  });
});
