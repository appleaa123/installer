import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillTemplate, runHeadless, runProcess } from "../../src/core/headless.js";
import { ProfileError, loadProfile } from "../../src/core/profile.js";
import { makeTempHome } from "../helpers/temp-home.js";

const FAKE = resolve("tests/fixtures/profiles/fake-agent.json");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fillTemplate", () => {
  it("replaces placeholders inside tokens without rescanning the values", () => {
    expect(fillTemplate(["-p", "{prompt}", "x{a}y"], { prompt: "{a}", a: "1" })).toEqual(["-p", "{a}", "x1y"]);
  });

  it("refuses a placeholder that has no value", () => {
    expect(() => fillTemplate(["{nope}"], {})).toThrow(ProfileError);
  });
});

describe("runProcess", () => {
  it("names a command that is not installed (Review Focus 2)", async () => {
    const result = await runProcess(["installer-test-no-such-agent"], await makeTempHome(), 5_000);
    expect(result.error).toBe("'installer-test-no-such-agent' is not installed");
  });

  it("kills a command that runs past the timeout (Review Focus 1)", async () => {
    const result = await runProcess([process.execPath, "-e", "setInterval(() => {}, 1000)"], await makeTempHome(), 300);
    expect(result.error).toBe("timed out after 300 ms");
  });
});

describe("runHeadless against the fake agent", () => {
  it("returns the text and the session id", async () => {
    const result = await runHeadless(await loadProfile(FAKE), { prompt: "Reply with exactly this word: alpha" }, { cwd: await makeTempHome() });
    expect(result).toMatchObject({ ok: true, text: "alpha", sessionId: expect.any(String) });
  });

  it("returns structured output when a schema is given", async () => {
    const request = { prompt: "Put this word in the field word: beta", schema: { type: "object" } };
    const result = await runHeadless(await loadProfile(FAKE), request, { cwd: await makeTempHome() });
    expect(result).toMatchObject({ ok: true, structured: { word: "beta" } });
  });

  it("resumes a session", async () => {
    const profile = await loadProfile(FAKE);
    const cwd = await makeTempHome();
    const first = await runHeadless(profile, { prompt: "Remember this word: gamma. Reply OK." }, { cwd });
    if (!first.ok || !first.sessionId) throw new Error("first call failed");
    const second = await runHeadless(profile, { prompt: "What word did I ask you to remember?", sessionId: first.sessionId }, { cwd });
    expect(second).toMatchObject({ ok: true, text: "gamma", sessionId: first.sessionId });
  });

  it.each([
    ["c4", "exited with code 1"],
    ["json", "did not print JSON"],
  ])("reports FAKE_AGENT_DROP=%s as a failure, not a crash (Review Focus 1)", async (drop, error) => {
    vi.stubEnv("FAKE_AGENT_DROP", drop);
    const result = await runHeadless(await loadProfile(FAKE), { prompt: "Reply with exactly this word: x" }, { cwd: await makeTempHome() });
    expect(result).toEqual({ ok: false, error });
  });

  it("passes a prompt with shell syntax through literally and runs nothing (Review Focus 5)", async () => {
    const cwd = await makeTempHome();
    const word = "$(touch${IFS}pwned);`touch${IFS}pwned2`\"'";
    const result = await runHeadless(await loadProfile(FAKE), { prompt: `Reply with exactly this word: ${word}` }, { cwd });
    expect(result).toMatchObject({ ok: true, text: word });
    expect((await readdir(cwd)).filter((name) => name.startsWith("pwned"))).toEqual([]);
  });
});
