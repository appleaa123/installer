/**
 * Opt-in live tests (D48): `npm run test:live` with the Skills Wiki variables in the environment, for example
 *   set -a; . ~/.config/installer-dev/.env; set +a; npm run test:live
 * Needs SKILLSWIKI_API_KEY and SKILLSWIKI_MCP_URL; everything is skipped when either is empty.
 * SKILLSWIKI_LIVE_RESOURCE=<pack>/<skill> enables the resource test. INSTALLER_LIVE_AGENT=1 enables the real
 * Claude Code C6 rehearsal (costs tokens, writes a temporary `swtest-installer` server to the user MCP config and
 * a temporary `skillswiki-live` keychain item, both removed afterwards; run it from a folder Claude Code trusts).
 * INSTALLER_LIVE_PROFILE names another bundled profile (D116); one without MCP templates skips the rehearsal.
 */
import { describe, expect, it } from "vitest";
import { deleteSecret, setSecret } from "../../src/core/keychain.js";
import { KEY_REJECTED_HINT, callTool } from "../../src/core/mcp.js";
import { probeMcp } from "../../src/core/probe.js";
import { loadProfile } from "../../src/core/profile.js";
import { headersHelperCommand, installerCliPath, registerMcp, unregisterMcp } from "../../src/core/register.js";
import { activeComboSlug, stripSkillWrapper } from "../../src/core/skillswiki.js";

const KEY = process.env.SKILLSWIKI_API_KEY ?? "";
const URL = process.env.SKILLSWIKI_MCP_URL ?? "";
const RESOURCE = process.env.SKILLSWIKI_LIVE_RESOURCE ?? "";
const AGENT = process.env.INSTALLER_LIVE_AGENT === "1";
const PROFILE = await loadProfile(process.env.INSTALLER_LIVE_PROFILE || "claude-code");
const REHEARSABLE = PROFILE.mcp_register !== undefined && PROFILE.headless.allow_tool !== undefined;
const target = { url: URL, key: KEY };

describe.skipIf(!KEY || !URL)("hosted Skills Wiki MCP (fact 5)", () => {
  it("rejects a wrong key with the secret hint", async () => {
    await expect(callTool({ url: URL, key: "not-the-key" }, "get_active_combo")).rejects.toThrow(KEY_REJECTED_HINT);
  });

  it("answers get_active_combo with the active combo's slug, or null when none is active", async () => {
    const slug = await activeComboSlug(target);
    expect(slug === null || typeof slug === "string").toBe(true);
  });

  it.skipIf(!RESOURCE)("serves a pack's resources through get_skill_resource (fact 6)", async () => {
    const [pack = "", skill = ""] = RESOURCE.split("/");
    const folder = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path: "" });
    expect(folder).toMatchObject({ ok: true, value: { resources: expect.any(Array) } });
    const first = (folder.ok ? (folder.value as { resources: { path: string }[] }).resources[0]?.path : undefined) ?? "";
    const file = await callTool(target, "get_skill_resource", { pack, skill_name: skill, path: first });
    expect(file).toMatchObject({ ok: true, value: { path: first, content: expect.any(String) } });
    const content = file.ok ? (file.value as { content: string }).content : "";
    expect(stripSkillWrapper(content)).not.toMatch(/^\s*<skill_[a-z]+>/);
  });
});

describe.skipIf(!KEY || !URL || !AGENT || !REHEARSABLE)(`real ${PROFILE.name} C6 rehearsal (fact 4)`, () => {
  const SERVER = "swtest-installer";
  const SECRET = "skillswiki-live";

  it("registers a headers-helper server, has claude -p call get_active_combo, then cleans up", async () => {
    const profile = PROFILE;
    const cwd = process.env.INSTALLER_LIVE_DIR ?? process.cwd();
    await setSecret(SECRET, KEY);
    try {
      await registerMcp(profile, SERVER, URL, headersHelperCommand(SECRET, process.execPath, installerCliPath()), cwd);
      const expectedSlug = await activeComboSlug(target);
      if (!expectedSlug) throw new Error("Activate a combo in the Skills Wiki dashboard before this test");
      await expect(probeMcp({ profile, cwd, serverName: SERVER, expectedSlug })).resolves.toEqual({ ok: true });
    } finally {
      await unregisterMcp(profile, SERVER, cwd);
      await deleteSecret(SECRET);
    }
  }, 300_000);
});
