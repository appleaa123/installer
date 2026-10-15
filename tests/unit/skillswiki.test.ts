import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { setSecret } from "../../src/core/keychain.js";
import { KEY_MISSING_HINT, URL_MISSING_HINT, activeComboSlug, fetchSkillswikiSolution, parseSkillswikiRef, requireSkillswikiUrl, skillswikiTarget, stripSkillWrapper, usesSkillswiki } from "../../src/core/skillswiki.js";
import type { Solution, StepDef } from "../../src/core/types.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";

const RECIPE = readFileSync(resolve("tests/fixtures/skillswiki/demo/install/recipe.json"), "utf8");
const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const started = await startFakeMcp(env);
  servers.push(started);
  return started;
}

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
});

describe("skillswiki: a bundled workflow's skills list (9.12 item 2)", () => {
  it("counts a skillswiki entry in a workflow's skills as using Skills Wiki", () => {
    const solution = { id: "s", version: "1.0.0", steps: [], workflows: [{ workflow: "w", skills: ["skillswiki:p/s/SKILL.md"] }] } as unknown as Solution;
    expect(usesSkillswiki(solution)).toBe(true);
    expect(usesSkillswiki({ ...solution, workflows: [{ workflow: "w", skills: ["/local/skill"] }] } as unknown as Solution)).toBe(false);
  });
});

describe("skillswiki: references", () => {
  it("splits pack, skill and a path with slashes", () => {
    expect(parseSkillswikiRef("skillswiki:demo/install/recipes/v1/recipe.json")).toEqual({ pack: "demo", skill: "install", path: "recipes/v1/recipe.json" });
  });

  it.each(["skillswiki:demo", "skillswiki:demo/install", "skillswiki:demo/install/", "skillswiki:/install/x", "https://x"])("refuses %s", (ref) => {
    expect(() => parseSkillswikiRef(ref)).toThrow(InputError);
  });

  it("strips one outer skill_* element and nothing else (fact 6)", () => {
    expect(stripSkillWrapper("<skill_reference>\n{ \"a\": 1 }\n</skill_reference>")).toBe('{ "a": 1 }');
    expect(stripSkillWrapper("<skill_script>\necho <skill_reference>x</skill_reference>\n</skill_script>")).toBe("echo <skill_reference>x</skill_reference>");
    expect(stripSkillWrapper("plain text")).toBe("plain text");
    expect(stripSkillWrapper("<skill_reference>\nopen")).toBe("<skill_reference>\nopen");
  });

  it("fetches a recipe through get_skill_resource with the wrapper removed", async () => {
    const fake = await server();
    await expect(fetchSkillswikiSolution({ url: fake.url, key: fake.key }, "skillswiki:demo/install/recipe.json")).resolves.toBe(RECIPE);
  });

  it("names the reference when Skills Wiki has no such file", async () => {
    const fake = await server();
    await expect(fetchSkillswikiSolution({ url: fake.url, key: fake.key }, "skillswiki:demo/install/nope.json")).rejects.toThrow(
      "Skills Wiki could not serve 'skillswiki:demo/install/nope.json': Resource not found: demo/install/nope.json",
    );
  });
});

describe("active combo (D37)", () => {
  it("returns the slug of the active combo", async () => {
    const fake = await server();
    await expect(activeComboSlug({ url: fake.url, key: fake.key })).resolves.toBe("demo-combo");
  });

  it("returns null when no combo is activated", async () => {
    const fake = await server({ FAKE_MCP_COMBO: "" });
    await expect(activeComboSlug({ url: fake.url, key: fake.key })).resolves.toBeNull();
  });

  it("lets a rejected key surface as the secret hint", async () => {
    const fake = await server();
    await expect(activeComboSlug({ url: fake.url, key: "nope" })).rejects.toThrow(ActionFailure);
  });
});

describe("start --url", () => {
  const step = (extra: Partial<StepDef>): StepDef => ({ step_id: "s", phase: "BRAIN", type: "auto", title: "S", why: "Needed.", blocking: true, ...extra });
  const solution = (...steps: StepDef[]): Solution => ({ id: "s", version: "1", steps });

  it("is needed by solutions that register, probe or check Skills Wiki", () => {
    expect(usesSkillswiki(solution(step({ auto: { action: "register_mcp" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ auto: { action: "probe_mcp" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ type: "human_action", verify: { check: "combo_active" } })))).toBe(true);
    expect(usesSkillswiki(solution(step({ auto: { action: "noop" } })))).toBe(false);
  });

  it("also counts a suggested workflow whose judge names a Skills Wiki skill, so start asks for the URL early", () => {
    const plain = { ...solution(step({ auto: { action: "noop" } })) };
    const withSkill: Solution = { ...plain, workflows: [{ workflow: "w", steps: [{ id: "j", judge: { instructions: "x", skill: "skillswiki:p/s/SKILL.md" } }] }] };
    const withoutSkill: Solution = { ...plain, workflows: [{ workflow: "w", steps: [{ id: "j", judge: { instructions: "x" } }] }] };
    expect(usesSkillswiki(withSkill)).toBe(true);
    expect(usesSkillswiki(withoutSkill)).toBe(false);
  });

  it.each(["https://wiki.test/mcp", "http://127.0.0.1:4321/mcp"])("accepts %s", (url) => {
    expect(requireSkillswikiUrl(url)).toBe(url);
  });

  it.each([undefined, "", "http://wiki.test/mcp", "ftp://wiki.test", "wiki.test/mcp"])("refuses %j", (url) => {
    expect(() => requireSkillswikiUrl(url)).toThrow(InputError);
  });
});
describe("skillswikiTarget", () => {
  it("needs the url and the stored key", async () => {
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    await expect(skillswikiTarget(undefined, env)).rejects.toThrow(URL_MISSING_HINT);
    await expect(skillswikiTarget("https://wiki.test/mcp", env)).rejects.toThrow(KEY_MISSING_HINT);
    await setSecret("skillswiki", "k-1", env);
    await expect(skillswikiTarget("https://wiki.test/mcp", env)).resolves.toEqual({ url: "https://wiki.test/mcp", key: "k-1" });
  });
});
