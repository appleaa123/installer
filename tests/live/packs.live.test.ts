/**
 * Opt-in live test of pack pinning (D48, D107): `npm run test:live` with SKILLSWIKI_API_KEY, SKILLSWIKI_MCP_URL and
 * SKILLSWIKI_LIVE_FILE=<pack>/<skill>/<path> in the environment reads ONE skill file twice through
 * `get_skill_resource` and checks that its text, and so its sha256 pin, is the same both times: content pinning
 * would otherwise see a new version on every check. Read-only: nothing is written to Skills Wiki. Skipped when a
 * variable is empty.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fetchSkillswikiSolution } from "../../src/core/skillswiki.js";

const KEY = process.env.SKILLSWIKI_API_KEY ?? "";
const URL = process.env.SKILLSWIKI_MCP_URL ?? "";
const RESOURCE = process.env.SKILLSWIKI_LIVE_FILE ?? "";
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe.skipIf(!KEY || !URL || RESOURCE.split("/").length < 3)("Skills Wiki skill files pin by content (D107)", () => {
  it("serves the same text twice, so its sha256 pin is stable", async () => {
    const target = { url: URL, key: KEY };
    const first = await fetchSkillswikiSolution(target, `skillswiki:${RESOURCE}`);
    const second = await fetchSkillswikiSolution(target, `skillswiki:${RESOURCE}`);
    expect(first.length).toBeGreaterThan(0);
    expect(sha256(second)).toBe(sha256(first));
  });
});
