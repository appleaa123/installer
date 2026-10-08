import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_LOCK_FILE, appendAudit, verifyAudit, type AuditEntry } from "../../src/core/audit.js";
import { deadPid } from "../helpers/dead-pid.js";
import { makeTempHome } from "../helpers/temp-home.js";

const entry = (event: string): AuditEntry => ({ ts: "2026-01-01T00:00:00.000Z", actor: "engine", event, ref: "x", payload: { event } });
const BUILT_AUDIT = pathToFileURL(resolve("dist/core/audit.js")).href;

/** A separate process appending `count` lines, the way the CLI and the MCP server do side by side. */
function appender(home: string, name: string, count: number): Promise<number | null> {
  const script = `const { appendAudit } = await import(${JSON.stringify(BUILT_AUDIT)});
for (let n = 0; n < ${count}; n += 1) await appendAudit(${JSON.stringify(home)}, { ts: "t", actor: "engine", event: "${name}." + n, ref: "x", payload: n });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  return new Promise((done) => child.once("exit", done));
}

describe("concurrent audit appends (D57)", () => {
  it("keeps one unbroken chain when one process appends twenty lines at once", async () => {
    const home = await makeTempHome();
    await Promise.all(Array.from({ length: 20 }, (_, n) => appendAudit(home, entry(`e${n}`))));
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 20 });
  });

  it("keeps one unbroken chain when four processes append at the same time", async () => {
    const home = await makeTempHome();
    const codes = await Promise.all(["a", "b", "c", "d"].map((name) => appender(home, name, 10)));
    expect(codes).toEqual([0, 0, 0, 0]);
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 40 });
    await expect(access(join(home, AUDIT_LOCK_FILE))).rejects.toThrow();
  });

  it("takes over a lock left by a process that is gone", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "audit"), { recursive: true });
    await writeFile(join(home, AUDIT_LOCK_FILE), String(deadPid()));
    await appendAudit(home, entry("after-crash"));
    await expect(verifyAudit(home)).resolves.toEqual({ ok: true, lines: 1 });
  });
});
