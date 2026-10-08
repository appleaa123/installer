import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractError, checkValues, contractTags, parseContract, requireEntity, type DataContract } from "../../src/core/contract.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import { DEFAULT_TOOLS } from "../../src/core/tool-set.js";
import { toolContext } from "../../src/core/tools.js";
import { makeTempHome } from "../helpers/temp-home.js";

const DATA_TEXT = readFileSync("tests/fixtures/solution-data.json", "utf8");
const raw = (): Record<string, unknown> => JSON.parse(DATA_TEXT) as Record<string, unknown>;
const contract = (): DataContract => parseContract(raw().data_contract);
const contact = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ entities: { contact: { key: "email", fields, ...extra } } });

describe("parseContract (§9.2)", () => {
  it("reads entities, fields, tags and the key, which is always required", () => {
    const entity = requireEntity(contract(), "contact");
    expect(entity.key).toBe("email");
    expect(entity.match_keys).toEqual(["email"]);
    expect(Object.keys(entity.fields)).toEqual(["name", "email", "notes", "balance"]);
    expect(entity.fields.email).toEqual({ type: "email", tags: ["personal"], required: true });
    expect(entity.fields.notes).toEqual({ type: "text", tags: [], required: false });
  });

  it.each([
    ["no entities", {}, "data_contract.entities must be an object"],
    ["a bad entity name", { entities: { "Contact-List": { key: "a", fields: { a: { type: "text" } } } } }, "entity name 'Contact-List' must be lowercase"],
    ["an unknown type", contact({ email: { type: "colour" } }), "contact.email.type must be one of text, email"],
    ["an unknown tag", contact({ email: { type: "email", tags: ["secret"] } }), "contact.email.tags must only use financial, protected_ground, personal"],
    ["an enum without options", contact({ email: { type: "email" }, state: { type: "enum" } }), "contact.state is an enum and needs options"],
    ["a key that is not a field", contact({ name: { type: "text" } }), "contact.key 'email' must be one of its fields"],
    ["a match key that is not a field", contact({ email: { type: "email" } }, { match_keys: ["phone"] }), "contact.match_keys must name its fields"],
    ["a bad field name", contact({ email: { type: "email" }, "Full Name": { type: "text" } }), "field name 'Full Name' must be lowercase"],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseContract(value)).toThrow(ContractError);
    expect(() => parseContract(value)).toThrow(message);
  });

  it("refuses an entity named like an object built-in", () => {
    expect(() => requireEntity(contract(), "constructor")).toThrow("No entity 'constructor' in the data contract; entities: contact");
  });
});

describe("the contract inside a solution", () => {
  it("keeps data_contract when the solution declares one, and adds nothing when it does not", () => {
    expect(parseSolution(raw()).data_contract?.entities.contact?.key).toBe("email");
    const { data_contract: _dropped, ...plain } = raw();
    expect(Object.keys(parseSolution(plain))).toEqual(["id", "version", "steps"]);
  });

  it("reports a bad contract as a solution error", () => {
    expect(() => parseSolution({ ...raw(), data_contract: { entities: [] } })).toThrow(SolutionError);
    expect(() => parseSolution({ ...raw(), data_contract: { entities: [] } })).toThrow("data_contract.entities must be an object");
  });
});

describe("contractTags (§9.3)", () => {
  it("gives each field's tags and none for unknown fields", () => {
    const tags = contractTags(contract());
    expect(tags({ entity: "contact", field: "balance" })).toEqual(["financial"]);
    expect(tags({ entity: "contact", field: "name" })).toEqual(["personal"]);
    expect(tags({ entity: "contact", field: "notes" })).toEqual([]);
    expect(tags({ entity: "other", field: "x" })).toEqual([]);
    expect(tags({ entity: "contact", field: "constructor" })).toEqual([]);
  });

  it("is the tag source of every tool call once the install pins a solution with a contract (replaces Plan 4's none)", async () => {
    const home = await makeTempHome();
    expect((await toolContext(home, "cli", DEFAULT_TOOLS)).tags({ entity: "contact", field: "balance" })).toEqual([]);
    await writePinnedSolution(home, DATA_TEXT);
    expect((await toolContext(home, "cli", DEFAULT_TOOLS)).tags({ entity: "contact", field: "balance" })).toEqual(["financial"]);
  });
});

describe("checkValues", () => {
  const entity = () => requireEntity(contract(), "contact");

  it("accepts a new record with every required field and trims the values", () => {
    expect(checkValues("contact", entity(), { name: " Ada ", email: "ada@example.com", balance: "12.50" }, "create")).toEqual({ name: "Ada", email: "ada@example.com", balance: "12.50" });
  });

  it.each([
    ["a missing required field", { email: "ada@example.com" }, "create", "contact needs 'name'"],
    ["a missing key", { name: "Ada" }, "create", "contact needs 'email'"],
    ["an unknown field", { name: "Ada", email: "ada@example.com", age: "3" }, "create", "contact has no field 'age'; fields: name, email, notes, balance"],
    ["a malformed email", { name: "Ada", email: "ada-at-example" }, "create", "contact.email must be an email address"],
    ["a malformed amount", { name: "Ada", email: "ada@example.com", balance: "12,50" }, "create", "contact.balance must be an amount such as 12.50"],
    ["a value that is not text", { name: 7, email: "ada@example.com" }, "create", "contact.name must be text"],
    ["a change of the key", { email: "new@example.com" }, "update", "contact's key 'email' cannot be changed"],
    ["clearing a required field", { name: "" }, "update", "contact needs 'name'"],
    ["an empty update", {}, "update", "Give at least one field of contact to change"],
    ["a list instead of an object", [], "update", "values must be an object of field names to text"],
  ] as const)("refuses %s", (_name, values, mode, message) => {
    expect(() => checkValues("contact", entity(), values, mode)).toThrow(message);
  });

  it("lets an update clear an optional field", () => {
    expect(checkValues("contact", entity(), { notes: "" }, "update")).toEqual({ notes: "" });
  });
});
