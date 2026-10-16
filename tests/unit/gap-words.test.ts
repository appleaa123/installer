import { describe, expect, it } from "vitest";
import type { Need } from "../../src/core/checks.js";
import { gapLines, gapWords, labelFor } from "../../src/core/gap-words.js";

/** Plan item 7 Task 7 (scope section 6): every no and not-checked line comes with four plain parts. */
const NEEDS: Need[] = ["answers", "reads:email", "reads:email-attachment", "reads:files", "reads:records", "reads:messages", "writes:records", "writes:files", "skills", "tools", "runner", "scheduler", "asks-first", "hooks"];

describe("gap words: four parts for every need", () => {
  it.each(NEEDS)("%s has a label and the four parts for no and not checked, and nothing for a yes", (need) => {
    expect(labelFor(need)).not.toBe(need);
    for (const kind of ["not-checked", "no-tested"] as const) {
      const gap = gapWords(need, kind);
      expect(gap?.missing.length).toBeGreaterThan(10);
      expect(gap?.why.length).toBeGreaterThan(10);
      expect(gap?.without.length).toBeGreaterThan(10);
      expect(gap?.options.length).toBeGreaterThan(0);
    }
    expect(gapWords(need, "yes-tested")).toBeNull();
    expect(gapWords(need, "yes-you-told-us")).toBeNull();
  });

  it("says a 'no' was tried and did not happen", () => {
    expect(gapWords("scheduler", "no-tested")?.missing).toMatch(/^TaskFollow tested and did not see/);
  });

  it("never claims a protection that was not tested", () => {
    const all = NEEDS.flatMap((need) => [gapWords(need, "not-checked"), gapWords(need, "no-tested")]).flatMap((gap) => (gap ? [gap.missing, gap.why, gap.without, ...gap.options] : []));
    for (const text of all) expect(text).not.toMatch(/\b(protected|guaranteed|safe|secure|always holds)\b/i);
  });

  it("lists options safest first: TaskFollow's own tool before draft-only before by hand", () => {
    const options = gapWords("asks-first", "not-checked")?.options ?? [];
    const at = (text: string) => options.findIndex((option) => option.includes(text));
    expect(at("TaskFollow's own tools")).toBeLessThan(at("draft-only"));
    expect(gapLines(gapWords("tools", "not-checked")!)).toHaveLength(4);
  });
});
