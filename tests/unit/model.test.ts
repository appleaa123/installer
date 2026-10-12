import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_FILE } from "../../src/core/audit.js";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { askJudge } from "../../src/core/judge.js";
import { setSecret } from "../../src/core/keychain.js";
import { MODEL_CONFIG, judgeBackend, loadModelConfig, modelClient, modelCommand, parseModelConfig } from "../../src/core/model.js";
import type { CapabilityMap, InstallState } from "../../src/core/types.js";
import { startFakeModel, type FakeModel } from "../helpers/fake-model.js";
import { makeTempHome } from "../helpers/temp-home.js";
import { LABEL_SCHEMA } from "../helpers/workflow-home.js";

const NOW = () => "2026-10-08T12:00:00.000Z";
const ANTHROPIC = { provider: "anthropic", model: "test-model" };
const COMPATIBLE = { provider: "openai_compatible", model: "vendor/test-model", base_url: "https://api.example.com/v1/" };
const SPEC = { instructions: "Label it.", schema: LABEL_SCHEMA, context_tools: [], max_tool_calls: 3 };
let fake: FakeModel;
let keychain: Record<string, string>;
beforeAll(async () => {
  fake = await startFakeModel();
  keychain = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
});
afterAll(() => fake.stop());
afterEach(() => vi.unstubAllEnvs());

const env = () => ({ ...fake.env, ...keychain });
const runtime = (c4: boolean, profile = "fake-agent"): CapabilityMap => ({
  profile, agent_version: "9.9.9", c2_shell: true, c4_headless: c4, c4_schema: c4, c5_resume: c4, c6_mcp: "not_probed", support_level: c4 ? 2 : 0, tier: "compatible", notes: [],
});
const state = (map: CapabilityMap | undefined): InstallState => ({ schema: 1, solution: { ref: "file:x", id: "x", version: "1" }, started_at: NOW(), steps: {}, ...(map ? { runtime: map } : {}) });

describe("the direct model's settings (D85)", () => {
  it("reads both providers, with a default max_tokens and no trailing slash", () => {
    expect(parseModelConfig(ANTHROPIC)).toEqual({ provider: "anthropic", model: "test-model", max_tokens: 4096 });
    expect(parseModelConfig(COMPATIBLE)).toEqual({ provider: "openai_compatible", model: "vendor/test-model", max_tokens: 4096, base_url: "https://api.example.com/v1" });
  });

  it.each([
    [{ provider: "gemini", model: "m" }, "provider must be one of anthropic, openai_compatible"],
    [{ provider: "anthropic" }, "'model' must be the provider's model id"],
    [{ ...ANTHROPIC, base_url: "https://x" }, "base_url is only for openai_compatible"],
    [{ ...COMPATIBLE, base_url: "http://api.example.com" }, "needs base_url, an https URL"],
    [{ ...ANTHROPIC, max_tokens: 1 }, "max_tokens must be"],
    [{ ...ANTHROPIC, key: "sk-1" }, "model does not take 'key'"],
  ])("refuses %j", (value, message) => {
    expect(() => parseModelConfig(value)).toThrow(InputError);
    expect(() => parseModelConfig(value)).toThrow(message);
  });

  it("installer model saves the settings privately, audits them and asks for the key; without a value it shows them", async () => {
    const home = await makeTempHome();
    expect(await modelCommand(home, JSON.stringify(ANTHROPIC), NOW, true)).toEqual({
      status: "saved", model: { provider: "anthropic", model: "test-model", max_tokens: 4096 }, key_stored: false, next: "Ask the person to run 'installer secret model' and enter their API key on the page that opens",
    });
    expect((await stat(join(home, MODEL_CONFIG))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(home, AUDIT_FILE), "utf8")).toContain('"event":"model.configured"');
    expect(await modelCommand(home, undefined, NOW)).toMatchObject({ model: { provider: "anthropic" }, key_stored: false });
    await expect(modelCommand(home, "{not json", NOW, true)).rejects.toThrow("--value must be JSON");
  });

  it("refuses to set or change the model from an agent's shell (no terminal): the key would follow base_url", async () => {
    const home = await makeTempHome();
    const attacker = { provider: "openai_compatible", model: "m", base_url: "https://attacker.example" };
    await expect(modelCommand(home, JSON.stringify(attacker), NOW)).rejects.toThrow(InputError);
    await expect(modelCommand(home, JSON.stringify(attacker), NOW)).rejects.toThrow("not by the agent");
    expect(await loadModelConfig(home)).toBeNull();
    const audit = (await readFile(join(home, AUDIT_FILE), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { actor: string; event: string });
    expect(audit.map((line) => [line.actor, line.event])).toEqual([["agent", "model.refused"], ["agent", "model.refused"]]);
  });
});

describe("the provider-neutral client, against a fake model server", () => {
  it("Anthropic Messages: the documented headers and body, the text back", async () => {
    fake.answer('{"label":"later","confidence":0.5}');
    const text = await modelClient(parseModelConfig(ANTHROPIC), fake.key, env()).complete("Label it.");
    expect(text).toBe('{"label":"later","confidence":0.5}');
    const request = fake.requests().at(-1);
    expect(request?.path).toBe("/v1/messages");
    expect(request?.headers).toMatchObject({ "x-api-key": fake.key, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(request?.body).toEqual({ model: "test-model", max_tokens: 4096, messages: [{ role: "user", content: "Label it." }] });
  });

  it("OpenAI-compatible chat completions under the configured base", async () => {
    fake.answer("hello");
    expect(await modelClient(parseModelConfig(COMPATIBLE), fake.key, env()).complete("Hi")).toBe("hello");
    expect(fake.requests().at(-1)).toMatchObject({ path: "/v1/chat/completions", headers: { authorization: `Bearer ${fake.key}` }, body: { model: "vendor/test-model" } });
  });

  it("a refused key names the fix and never the key; a refusal is an error", async () => {
    const wrong = modelClient(parseModelConfig(ANTHROPIC), "sk-wrong-secret", env()).complete("x");
    await expect(wrong).rejects.toThrow(ActionFailure);
    await expect(modelClient(parseModelConfig(ANTHROPIC), "sk-wrong-secret", env()).complete("x")).rejects.toThrow(/^(?!.*sk-wrong-secret).*run 'installer secret model'/);
    fake.answer("__refusal");
    await expect(modelClient(parseModelConfig(ANTHROPIC), fake.key, env()).complete("x")).rejects.toThrow("stop_reason refusal");
  });
});

describe("which way a judge is asked (D85)", () => {
  it("uses the agent when the probe found headless calls", async () => {
    expect((await judgeBackend(await makeTempHome(), state(runtime(true)), env())).name).toBe("profile");
  });

  it("falls back to the direct model when the agent has no headless calls, and judges with it", async () => {
    const home = await makeTempHome();
    await modelCommand(home, JSON.stringify(ANTHROPIC), NOW, true);
    await setSecret("model", fake.key, keychain);
    fake.answer("```json\n{\"label\":\"now\",\"confidence\":0.75}\n```");
    const backend = await judgeBackend(home, state(runtime(false)), env());
    expect(backend.name).toBe("model");
    expect(await askJudge(backend, SPEC, "Call back today", [], null)).toEqual({ status: "ok", value: { label: "now", confidence: 0.75 }, attempts: 1 });
  });

  it("falls back when the agent's terms do not allow automatic calls", async () => {
    const dir = await makeTempHome();
    const profile = JSON.parse(await readFile("tests/fixtures/profiles/fake-agent.json", "utf8")) as Record<string, unknown>;
    await writeFile(join(dir, "blocked-agent.json"), JSON.stringify({ ...profile, id: "blocked-agent", tos_review: { status: "blocked", note: "Terms forbid third-party calls." } }));
    vi.stubEnv("INSTALLER_PROFILE_DIR", dir);
    const home = await makeTempHome();
    await modelCommand(home, JSON.stringify(COMPATIBLE), NOW, true);
    await setSecret("model", fake.key, keychain);
    expect((await judgeBackend(home, state(runtime(true, "blocked-agent")), env())).name).toBe("model");
  });

  it("says what to set up when there is no way to ask a judge", async () => {
    const home = await makeTempHome();
    await expect(judgeBackend(home, state(undefined), env())).rejects.toThrow("no direct model is set up: run 'installer model --value <json>' and 'installer secret model'");
    await modelCommand(home, JSON.stringify(ANTHROPIC), NOW, true);
    await expect(judgeBackend(home, state(runtime(false)), { ...env(), INSTALLER_KEYCHAIN_DIR: await makeTempHome() })).rejects.toThrow("ask the person to run 'installer secret model'");
  });
});
