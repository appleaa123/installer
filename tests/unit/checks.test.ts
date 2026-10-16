import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { ABILITIES_DIR, CHECKS_DIR, abilities, answerChallenge, freshResult, loadChallenge, markChallenge, recordResult, startChallenge } from "../../src/core/checks.js";
import { InputError } from "../../src/core/inputs.js";
import { makeTempHome } from "../helpers/temp-home.js";

const AT = "2026-10-16T12:00:00.000Z";
const later = (minutes: number) => new Date(Date.parse(AT) + minutes * 60_000).toISOString();
const NOT_TTY = { interactive: false, parents: ["/usr/bin/node"] };
const events = async (home: string) => (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { event: string }).event);

describe("checks: challenges", () => {
  it("stores the word only as a salted hash, never in the clear", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["answers"], test: "t1", agent: "claude-code", agentVersion: "2.1.301", ttlMs: 30 * 60_000, withWord: true }, AT);
    expect(word).toMatch(/^[A-Z]+-[A-Z2-9]{4}$/);
    const text = await readFile(join(home, CHECKS_DIR, `${challenge.id}.json`), "utf8");
    expect(text).not.toContain(word ?? "unreachable");
    expect(JSON.parse(text)).toMatchObject({ id: challenge.id, status: "open", word_salt: expect.any(String), word_hash: expect.any(String) });
    expect(await loadChallenge(home, challenge.id)).toMatchObject({ test: "t1", needs: ["answers"] });
  });

  it("refuses an unknown, an expired or a used challenge, and audits each refusal", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["answers"], test: "t1", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    await expect(markChallenge(home, "c00000000", "X", NOT_TTY, AT)).rejects.toThrow(InputError);
    await expect(markChallenge(home, challenge.id, word ?? "", NOT_TTY, later(5))).rejects.toThrow("expired");
    const fresh = await startChallenge(home, { needs: ["answers"], test: "t1", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    expect(await markChallenge(home, fresh.challenge.id, fresh.word ?? "", NOT_TTY, AT)).toMatchObject({ result: "yes-tested" });
    await expect(markChallenge(home, fresh.challenge.id, fresh.word ?? "", NOT_TTY, AT)).rejects.toThrow("already");
    expect((await events(home)).filter((event) => event === "check.refused")).toHaveLength(3);
  });

  it("records a mark from an interactive terminal as not checked: was that you?", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["answers"], test: "t1", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    const result = await markChallenge(home, challenge.id, word ?? "", { interactive: true, parents: [] }, AT);
    expect(result).toMatchObject({ result: "not-checked", reason: expect.stringContaining("interactive terminal") });
  });

  it("cancels after two wrong words, and never stores what was typed", async () => {
    const home = await makeTempHome();
    const { challenge } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    expect(await answerChallenge(home, challenge.id, "Lunch with Sam on Friday", AT)).toMatchObject({ result: "not-checked", reason: expect.stringContaining("try once more") });
    expect(await answerChallenge(home, challenge.id, "Another stranger subject", AT)).toMatchObject({ result: "not-checked", reason: expect.stringContaining("cancelled") });
    expect((await loadChallenge(home, challenge.id))?.status).toBe("cancelled");
    const stored = (await readdir(join(home, ABILITIES_DIR))).map((name) => join(home, ABILITIES_DIR, name));
    for (const file of stored) expect(await readFile(file, "utf8")).not.toMatch(/Sam|stranger/);
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).not.toMatch(/Sam|stranger/);
  });

  it("answers a challenge with the right word, typed loosely", async () => {
    const home = await makeTempHome();
    const { challenge, word } = await startChallenge(home, { needs: ["reads:email"], test: "t2", agent: "a", agentVersion: null, ttlMs: 60_000, withWord: true }, AT);
    expect(await answerChallenge(home, challenge.id, ` ${(word ?? "").toLowerCase().replace("-", " ")} `, AT)).toMatchObject({ result: "yes-tested", need: "reads:email", challenge: challenge.id });
  });
});

describe("checks: results and freshness", () => {
  const result = (at: string, version: string | null, extra = {}) => ({ need: "runner" as const, result: "yes-tested" as const, reason: "test", at, agent: "claude-code", agent_version: version, test: "t7", ...extra });

  it("keeps each result as its own numbered record", async () => {
    const home = await makeTempHome();
    await Promise.all([recordResult(home, result(AT, "1")), recordResult(home, result(AT, "1"))]);
    expect(await abilities(home)).toHaveLength(2);
  });

  it("gives the newest fresh result; none after a version change or 30 days", async () => {
    const home = await makeTempHome();
    await recordResult(home, result(AT, "2.1.300"));
    await recordResult(home, result(later(10), "2.1.301", { result: "no-tested" }));
    expect(await freshResult(home, "runner", "claude-code", "2.1.301", later(20))).toMatchObject({ result: "no-tested" });
    expect(await freshResult(home, "runner", "claude-code", "2.1.302", later(20))).toBeNull();
    expect(await freshResult(home, "runner", "claude-code", "2.1.301", later(31 * 24 * 60))).toBeNull();
    expect(await freshResult(home, "runner", "other-agent", null, later(20))).toBeNull();
  });

  it("keeps a workflow's result apart from the agent's general one", async () => {
    const home = await makeTempHome();
    await recordResult(home, result(AT, null, { need: "skills", workflow: "brief" }));
    expect(await freshResult(home, "skills", "claude-code", null, AT, "brief")).not.toBeNull();
    expect(await freshResult(home, "skills", "claude-code", null, AT, "other")).toBeNull();
  });
});
