import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** R9 / D27: the engine and its fixtures must not contain industry vocabulary. */
const BANNED = /\b(tenants?|landlords?|realtors?|leases?|rent|rental|mortgages?|propert(y|ies)(?!\s*:)|listings?|brokerages?)\b/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("industry neutrality", () => {
  it.each([...files("src"), ...files("tests/fixtures")])("%s has no industry vocabulary", (path) => {
    const match = BANNED.exec(readFileSync(path, "utf8"));
    expect(match?.[0] ?? null).toBeNull();
  });
});
