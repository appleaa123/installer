import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { FLOOR_CATEGORIES, deriveLevel, loadClientRules, needsApproval, requiredRole, roleAtLeast, type FieldRef, type FieldTag, type TagSource } from "../../src/core/levels.js";
import { makeTempHome } from "../helpers/temp-home.js";

/** Test-only tag source: the shape Plan 5's data contract will provide. */
const TAGGED: Readonly<Record<string, readonly FieldTag[]>> = { "item.amount": ["financial"], "item.group": ["protected_ground"], "item.email": ["personal"] };
const TAGS: TagSource = (field: FieldRef) => TAGGED[`${field.entity}.${field.field}`] ?? [];
const facts = (extra: Partial<Parameters<typeof deriveLevel>[0]> = {}) => ({ tool: "demo.write", categories: [], writes: [], ...extra });

describe("the compiled floor (D24)", () => {
  it("has the seven categories of spec §11.3, in order", () => {
    expect(FLOOR_CATEGORIES).toEqual(["legal_notice", "money", "contract", "irreversible", "personal_data_export", "policy_change", "protected_ground"]);
  });
});

describe("deriveLevel (§11.4)", () => {
  it("defaults a tool with no declared level to L2", () => {
    expect(deriveLevel(facts(), TAGS, {})).toEqual({ level: "L2", reasons: ["no declared level (default L2)"] });
  });

  it.each([["L0"], ["L1"], ["L2"], ["L3"]] as const)("keeps a declared %s", (level) => {
    expect(deriveLevel(facts({ level }), TAGS, {}).level).toBe(level);
  });

  it("raises any floor category to L3, whatever the tool declares", () => {
    expect(deriveLevel(facts({ level: "L0", categories: ["irreversible"] }), TAGS, {})).toEqual({ level: "L3", reasons: ["floor: irreversible"] });
  });

  it.each([["amount", "financial"], ["group", "protected_ground"]])("raises a write of a %s field (%s) to L3", (field, tag) => {
    expect(deriveLevel(facts({ level: "L1", writes: [{ entity: "item", field }] }), TAGS, {})).toEqual({ level: "L3", reasons: [`writes item.${field} (${tag})`] });
  });

  it("does not raise a write of a personal field", () => {
    expect(deriveLevel(facts({ level: "L1", writes: [{ entity: "item", field: "email" }] }), TAGS, {}).level).toBe("L1");
  });

  it("lets a client rule raise a level", () => {
    expect(deriveLevel(facts({ level: "L1" }), TAGS, { "demo.write": "L2" })).toEqual({ level: "L2", reasons: ["client rule L2"] });
  });

  it("never lets a client rule lower the floor or a declared level", () => {
    expect(deriveLevel(facts({ categories: ["money"] }), TAGS, { "demo.write": "L0" }).level).toBe("L3");
    expect(deriveLevel(facts({ level: "L2" }), TAGS, { "demo.write": "L1" }).level).toBe("L2");
  });

  it("ignores rules for other tools", () => {
    expect(deriveLevel(facts({ level: "L0" }), TAGS, { "other.tool": "L3" }).level).toBe("L0");
  });
});

describe("roles (§11.9)", () => {
  it("maps levels to the role that may approve them", () => {
    expect([requiredRole("L0"), requiredRole("L1"), requiredRole("L2"), requiredRole("L3")]).toEqual([null, null, "member", "decision_maker"]);
    expect([needsApproval("L1"), needsApproval("L2")]).toEqual([false, true]);
  });

  it("ranks the decision maker above a member", () => {
    expect([roleAtLeast("decision_maker", "member"), roleAtLeast("member", "decision_maker"), roleAtLeast("member", "member")]).toEqual([true, false, true]);
  });
});

describe("loadClientRules", () => {
  it("returns no rules when the file is missing", async () => {
    await expect(loadClientRules(await makeTempHome())).resolves.toEqual({});
  });

  it("reads tool levels from config/approval-rules.json", async () => {
    const home = await makeTempHome();
    await mkdir(join(home, "config"));
    await writeFile(join(home, "config", "approval-rules.json"), JSON.stringify({ tools: { "memo.add": "L2" } }));
    await expect(loadClientRules(home)).resolves.toEqual({ "memo.add": "L2" });
  });

  it.each([["not json", "is not valid JSON"], ['{"tools":[]}', "must be"], ['{"tools":{"memo.add":"L9"}}', "'memo.add' must be one of L0, L1, L2, L3"]])("refuses %s", async (text, message) => {
    const home = await makeTempHome();
    await mkdir(join(home, "config"));
    await writeFile(join(home, "config", "approval-rules.json"), text);
    await expect(loadClientRules(home)).rejects.toThrow(InputError);
    await expect(loadClientRules(home)).rejects.toThrow(message);
  });

  it.skipIf(process.platform === "win32")("refuses a rules file reached through a symbolic link (D34)", async () => {
    const home = await makeTempHome();
    const outside = await makeTempHome();
    await writeFile(join(outside, "approval-rules.json"), "{}");
    await symlink(outside, join(home, "config"));
    await expect(loadClientRules(home)).rejects.toThrow("goes through a symbolic link");
  });
});
