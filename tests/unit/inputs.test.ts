import { describe, expect, it } from "vitest";
import { InputError, isValidCron, validateInput } from "../../src/core/inputs.js";

describe("validateInput", () => {
  it("trims text and rejects blank text", () => {
    expect(validateInput({ kind: "text" }, "  hello ")).toBe("hello");
    expect(() => validateInput({ kind: "text" }, "   ")).toThrow(InputError);
    expect(() => validateInput({ kind: "text" }, 42)).toThrow(InputError);
  });

  it("accepts only listed choices", () => {
    const input = { kind: "choice", options: ["yes", "no"] } as const;
    expect(validateInput(input, "yes")).toBe("yes");
    expect(() => validateInput(input, "maybe")).toThrow(InputError);
  });

  it("dedupes multi_choice and rejects unknown or empty selections", () => {
    const input = { kind: "multi_choice", options: ["a", "b", "c"] } as const;
    expect(validateInput(input, ["a", "b", "a"])).toEqual(["a", "b"]);
    expect(() => validateInput(input, ["a", "z"])).toThrow(InputError);
    expect(() => validateInput(input, [])).toThrow(InputError);
  });

  it("requires a boolean for confirm", () => {
    expect(validateInput({ kind: "confirm" }, true)).toBe(true);
    expect(() => validateInput({ kind: "confirm" }, "yes")).toThrow(InputError);
  });

  it("rejects non-finite numbers", () => {
    expect(validateInput({ kind: "number" }, 3)).toBe(3);
    expect(() => validateInput({ kind: "number" }, Number.NaN)).toThrow(InputError);
    expect(() => validateInput({ kind: "number" }, "3")).toThrow(InputError);
  });

  it("accepts 24-hour HH:MM only", () => {
    expect(validateInput({ kind: "time" }, "09:00")).toBe("09:00");
    expect(validateInput({ kind: "time" }, "17:30")).toBe("17:30");
    for (const bad of ["9:00", "24:00", "12:60", "noon"]) {
      expect(() => validateInput({ kind: "time" }, bad)).toThrow(InputError);
    }
  });

  it("validates cron expressions", () => {
    expect(validateInput({ kind: "cron" }, "0 9 * * 1-5")).toBe("0 9 * * 1-5");
    expect(() => validateInput({ kind: "cron" }, "every day")).toThrow(InputError);
  });

  it.each(["secret", "oauth"] as const)("never accepts %s through submit (R4)", (kind) => {
    expect(() => validateInput({ kind }, "anything")).toThrow(/never accepted through submit/);
  });

  it("rejects a value for a step that takes no input", () => {
    expect(() => validateInput(undefined, "x")).toThrow(InputError);
  });
});

describe("isValidCron", () => {
  it.each(["0 9 * * 1-5", "*/15 * * * *", "0 9,17 * * *", "30 8 1 1 0"])("accepts %s", (expr) => {
    expect(isValidCron(expr)).toBe(true);
  });

  it.each(["0 9 * *", "60 * * * *", "0 24 * * *", "* * 0 * *", "0 9 * * 8", "*/0 * * * *", "5-1 * * * *"])(
    "rejects %s",
    (expr) => {
      expect(isValidCron(expr)).toBe(false);
    },
  );
});
