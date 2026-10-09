/**
 * Opt-in live test of one judge call (D48, D83): `npm run test:live` runs ONE headless call through the developer's
 * own Claude Code (`claude -p … --output-format json --tools "" --strict-mcp-config --json-schema …`), which uses
 * their subscription, with a two-label schema. INSTALLER_LIVE_PROFILE names another bundled profile (set by
 * `installer certify --profile <id>`, D116). Skipped when that agent is not installed. It sends no message, writes
 * nothing outside a temporary folder and calls no model API directly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askJudge, profileBackend } from "../../src/core/judge.js";
import { detectAgent } from "../../src/core/probe.js";
import { loadProfile } from "../../src/core/profile.js";

const PROFILE = await loadProfile(process.env.INSTALLER_LIVE_PROFILE || "claude-code");
const HAS_AGENT = (await detectAgent([PROFILE], tmpdir())) !== null;
const SCHEMA = { type: "object", properties: { label: { type: "string", enum: ["sky", "other"] } }, required: ["label"], additionalProperties: false };

describe.skipIf(!HAS_AGENT)(`one real judge call through ${PROFILE.name} (D83)`, () => {
  it("answers with JSON that fits the schema, with every tool off", async () => {
    const backend = profileBackend(PROFILE, mkdtempSync(join(tmpdir(), "installer-judge-live-")));
    const spec = { instructions: "Is the input about the sky? Put sky or other in the field label.", schema: SCHEMA, context_tools: [], max_tool_calls: 0 };
    const outcome = await askJudge(backend, spec, "The sky is clear and blue today.", [], null);
    expect(outcome).toMatchObject({ status: "ok", value: { label: "sky" } });
  }, 240_000);
});
