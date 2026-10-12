import { describe, expect, it } from "vitest";
import { ExpressionError, conditionRoots, holds, interpolate, lookup, parseCondition, templateRoots } from "../../src/core/expressions.js";

const SCOPE = {
  fetch: { messages: [{ from: "a@example.com", size: 3 }, { from: "b@example.com", size: 9 }], count: 2 },
  sort: [{ label: "urgent" }, { label: "later" }],
  item: { text: "Hello ${fetch.count}", id: 7 },
  run: { id: "2026-10-08-1a2b3c4d" },
  empty: [],
};

describe("paths (§10.2)", () => {
  it.each([
    ["fetch.count", 2],
    ["fetch.messages[1].from", "b@example.com"],
    ["fetch.messages.0.size", 3],
    ["fetch.messages[*].from", ["a@example.com", "b@example.com"]],
    ["sort[*].label", ["urgent", "later"]],
    ["fetch.missing", undefined],
    ["fetch.count.deeper", undefined],
  ])("reads %s", (path, value) => {
    expect(lookup(SCOPE, path)).toEqual(value);
  });

  it.each([["fetch..count"], ["1fetch"], ["fetch.messages[x]"], ["fetch messages"], [""]])("refuses the path %j", (path) => {
    expect(() => lookup(SCOPE, path)).toThrow(ExpressionError);
  });
});

describe("interpolate", () => {
  it("puts the value itself where a string is one whole reference, and text everywhere else", () => {
    expect(interpolate({ to: "${fetch.messages[*].from}", text: "There are ${fetch.count} messages", n: 5, list: ["${run.id}"] }, SCOPE)).toEqual({
      to: ["a@example.com", "b@example.com"], text: "There are 2 messages", n: 5, list: ["2026-10-08-1a2b3c4d"],
    });
  });

  it("writes objects inside text as JSON", () => {
    expect(interpolate("first: ${fetch.messages[0]}", SCOPE)).toBe('first: {"from":"a@example.com","size":3}');
  });

  it("never expands a reference that arrives inside a value (a judge's output stays text)", () => {
    expect(interpolate("${item.text}", SCOPE)).toBe("Hello ${fetch.count}");
    expect(interpolate("said: ${item.text}", SCOPE)).toBe("said: Hello ${fetch.count}");
  });

  it("refuses a reference with no value, naming it", () => {
    expect(() => interpolate({ text: "${fetch.nothing}" }, SCOPE)).toThrow("${fetch.nothing} has no value");
  });

  it("lists the roots a template refers to", () => {
    expect(templateRoots({ a: "${fetch.count} and ${item.id}", b: ["${run.id}"], c: 3 })).toEqual(["fetch", "item", "run"]);
  });
});

describe("when conditions", () => {
  it.each([
    ["fetch.count == 2", true],
    ["fetch.count != 2", false],
    ["fetch.count > 1 and fetch.count <= 2", true],
    ["len(fetch.messages) >= 3 or len(sort) == 2", true],
    ["not (fetch.count < 2)", true],
    ["'urgent' in sort[*].label", true],
    ["'example' in fetch.messages[0].from", true],
    ["'never' in sort[*].label", false],
    ["len(empty) == 0", true],
    ["empty", false],
    ["fetch.missing == null", true],
    ["fetch.missing", false],
    ["item.id == 7 and true", true],
    ["\"later\" == sort[1].label", true],
    ["fetch.count > 'a'", false],
  ])("%s is %s", (condition, value) => {
    expect(holds(condition, SCOPE)).toBe(value);
  });

  it.each([["fetch.count =="], ["(fetch.count == 2"], ["len fetch"], ["fetch.count ; rm"], ["and fetch"], ["a == b c"]])("refuses %j", (condition) => {
    expect(() => parseCondition(condition)).toThrow(ExpressionError);
  });

  it("lists the roots a condition reads", () => {
    expect(conditionRoots(parseCondition("len(fetch.messages) > 0 and not item.done"))).toEqual(["fetch", "item"]);
  });
});
