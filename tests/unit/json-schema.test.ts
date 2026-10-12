import { describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { checkSchema, validateSchema } from "../../src/core/json-schema.js";

const LABEL = {
  type: "object",
  properties: { label: { type: "string", enum: ["urgent", "later"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, notes: { type: "array", items: { type: "string", maxLength: 5 }, maxItems: 2 } },
  required: ["label", "confidence"],
  additionalProperties: false,
};

describe("judge output schemas (D16)", () => {
  it("accepts a value that fits", () => {
    expect(validateSchema(LABEL, { label: "urgent", confidence: 0.9, notes: ["ok"] })).toEqual([]);
  });

  it("names every way a value breaks the schema", () => {
    expect(validateSchema(LABEL, { label: "soon", notes: ["too long", "b", "c"], level: "L0" })).toEqual([
      "$.confidence is missing", "$.level is not allowed", "$.label must be one of \"urgent\", \"later\"",
      "$.notes has more than 2 items", "$.notes[0] is longer than 5",
    ]);
  });

  it.each([
    [{ type: "integer" }, 1.5, "$ must be integer, not number"],
    [{ type: ["string", "null"] }, 3, "$ must be string or null, not number"],
    [{ type: "number", minimum: 0 }, -1, "$ is below 0"],
    [{ type: "string", minLength: 2 }, "a", "$ is shorter than 2"],
    [{ type: "object" }, [], "$ must be object, not array"],
  ])("checks %j", (schema, value, error) => {
    expect(validateSchema(schema, value)).toEqual([error]);
  });

  it.each([
    [{ type: "object", pattern: "x" }, "uses 'pattern'"],
    [{ type: "text" }, "type must be one of"],
    [{ type: "object", properties: { a: { oneOf: [] } } }, "schema > a uses 'oneOf'"],
    [{ required: "a" }, "required must list names"],
    [{ additionalProperties: {} }, "additionalProperties must be true or false"],
    [[], "must be a JSON object"],
  ])("refuses the schema %j when a workflow is loaded", (schema, message) => {
    expect(() => checkSchema(schema)).toThrow(InputError);
    expect(() => checkSchema(schema)).toThrow(message);
  });

  it("accepts the subset it checks", () => {
    expect(() => checkSchema(LABEL)).not.toThrow();
  });
});
