import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileError, listBundledProfiles, loadProfile, parseProfile, versionAtLeast } from "../../src/core/profile.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");
const valid = {
  id: "x", name: "X", min_version: "1.0.0",
  detect: { cmd: ["x", "--version"], match: "X" },
  headless: { cmd: ["x", "-p", "{prompt}"], result_path: "result", session_path: "session_id" },
  tos_review: { status: "ok", note: "n" },
};

describe("runtime profiles", () => {
  it("loads the bundled Claude Code profile by id", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile).toMatchObject({ id: "claude-code", headless: { result_path: "result" }, schema: { result_path: "structured_output" } });
  });

  it("carries the verified MCP templates and tools-off flags of Claude Code (D52)", async () => {
    const profile = await loadProfile("claude-code");
    expect(profile.headless.cmd).toEqual(["claude", "-p", "{prompt}", "--output-format", "json"]);
    expect(profile.headless.tools_off).toEqual(["--tools", "", "--strict-mcp-config"]);
    expect(profile.headless.allow_tool).toEqual(["--allowedTools", "{tool}"]);
    expect(profile.mcp_register?.cmd).toEqual(["claude", "mcp", "add-json", "-s", "user", "{name}", "{config_json}"]);
    expect(profile.mcp_remove?.cmd).toEqual(["claude", "mcp", "remove", "-s", "user", "{name}"]);
  });

  it("lists the bundled profiles", async () => {
    expect((await listBundledProfiles()).map((profile) => profile.id)).toEqual(["claude-code"]);
  });

  it("loads a profile by path and remembers its folder", async () => {
    const profile = await loadProfile(FAKE);
    expect(profile.id).toBe("fake-agent");
    expect(profile.dir).toBe(resolve("tests/fixtures/profiles"));
  });

  it("names an unknown profile id", async () => {
    await expect(loadProfile("no-such-agent")).rejects.toThrow("Unknown runtime profile 'no-such-agent'");
  });

  it.each([
    ["a headless command without {prompt}", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p"] } }, /headless.cmd must contain \{prompt\}/],
    ["a schema flag without {schema_json}", { ...valid, schema: { flag: ["--s"], result_path: "r" } }, /schema.flag must contain \{schema_json\}/],
    ["a resume flag without {session_id}", { ...valid, resume: { flag: ["-r"] } }, /resume.flag must contain \{session_id\}/],
    ["an empty detect command", { ...valid, detect: { cmd: [], match: "X" } }, /detect.cmd must be a non-empty list of strings/],
    ["an unknown tos status", { ...valid, tos_review: { status: "maybe", note: "n" } }, /tos_review.status/],
    ["an id with capitals", { ...valid, id: "Claude" }, /id must be lowercase/],
    ["a placeholder the command cannot use", { ...valid, headless: { ...valid.headless, cmd: ["x", "-p", "{prompt}", "{session_id}"] } }, /headless.cmd uses \{session_id\}/],
    ["an allow_tool without {tool}", { ...valid, headless: { ...valid.headless, allow_tool: ["--allowedTools"] } }, /headless.allow_tool must contain \{tool\}/],
    ["an mcp_register without {config_json}", { ...valid, mcp_register: { cmd: ["x", "mcp", "add", "{name}"] } }, /mcp_register.cmd must contain \{config_json\}/],
    ["an mcp_remove without {name}", { ...valid, mcp_remove: { cmd: ["x", "mcp", "remove"] } }, /mcp_remove.cmd must contain \{name\}/],
    ["an mcp_remove that uses {prompt}", { ...valid, mcp_remove: { cmd: ["x", "{name}", "{prompt}"] } }, /mcp_remove.cmd uses \{prompt\}/],
  ])("refuses %s", (_name, raw, message) => {
    expect(() => parseProfile(raw, "/p")).toThrow(ProfileError);
    expect(() => parseProfile(raw, "/p")).toThrow(message);
  });

  it.each([
    ["2.1.294", "2.1.0", true],
    ["2.1.0", "2.1.0", true],
    ["2.0.99", "2.1.0", false],
    ["10.0.0", "9.9.9", true],
  ])("versionAtLeast(%s, %s) is %s", (actual, min, expected) => {
    expect(versionAtLeast(actual, min)).toBe(expected);
  });
});
