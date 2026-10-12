/**
 * Opt-in live test of the learning loop's read (D48, D97): `npm run test:live` with SKILLSWIKI_API_KEY and
 * SKILLSWIKI_MCP_URL in the environment makes ONE read-only `learning_list` call for the pack of the active combo's
 * first skill. It never calls `learning_record`: nothing is written to Skills Wiki. Skipped when either variable is
 * empty or no combo is active.
 */
import { describe, expect, it } from "vitest";
import { callTool } from "../../src/core/mcp.js";

const KEY = process.env.SKILLSWIKI_API_KEY ?? "";
const URL = process.env.SKILLSWIKI_MCP_URL ?? "";
const target = { url: URL, key: KEY };

describe.skipIf(!KEY || !URL)("Skills Wiki learning_list (fact 3)", () => {
  it("answers for the active combo's pack, or says Learning Mode is off", async () => {
    const combo = await callTool(target, "get_active_combo");
    const skills = combo.ok && typeof combo.value === "object" && combo.value !== null ? ((combo.value as { skills?: unknown }).skills ?? []) : [];
    const pack = Array.isArray(skills) && typeof skills[0] === "string" ? skills[0].split("/")[0] ?? "" : "";
    if (pack === "") return;
    const listed = await callTool(target, "learning_list", { pack });
    if (!listed.ok) expect(listed.error).toMatch(/learning/i);
    else expect(typeof listed.value).toBe("object");
  });
});
