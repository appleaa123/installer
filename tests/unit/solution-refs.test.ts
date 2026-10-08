import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SOLUTION_BYTES, fetchHttps, loadSolutionSource } from "../../src/core/solution.js";
import { FIXTURE_PATH } from "../helpers/memory-deps.js";

const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const URL_OK = "https://example.test/s.json";
/** A constructed Response has an empty url; set the final URL the way fetch would after redirects. */
const at = (url: string, response: Response): Response => Object.defineProperty(response, "url", { value: url });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("https: solution refs", () => {
  it("loads a solution through the fetcher and keeps its exact text", async () => {
    const loaded = await loadSolutionSource(URL_OK, async () => FIXTURE_TEXT);
    expect(loaded.solution.id).toBe("fixture-basic");
    expect(loaded.text).toBe(FIXTURE_TEXT);
  });

  it("fetchHttps returns the body of a 200 answer", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(at(URL_OK, new Response(FIXTURE_TEXT)));
    await expect(fetchHttps(URL_OK)).resolves.toBe(FIXTURE_TEXT);
  });

  it.each([
    ["a non-200 answer", () => at(URL_OK, new Response("gone", { status: 404 })), /answered HTTP 404/],
    ["a redirect to http", () => at("http://example.test/s.json", new Response(FIXTURE_TEXT)), /redirected away from https/],
    ["a body over the size cap", () => at(URL_OK, new Response("x".repeat(MAX_SOLUTION_BYTES + 1))), /larger than 1000000 bytes/],
  ])("refuses %s (Review Focus 3)", async (_name, response, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response());
    await expect(fetchHttps(URL_OK)).rejects.toThrow(message);
  });

  it("names the URL when the network fails (Review Focus 3)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchHttps(URL_OK)).rejects.toThrow("Cannot fetch solution URL 'https://example.test/s.json' (fetch failed)");
  });

  it.each(["http://example.test/s.json", "ftp://example.test/s.json"])("refuses the unsupported ref %s", async (ref) => {
    await expect(loadSolutionSource(ref)).rejects.toThrow(/use file:<path> or https:/);
  });

  it("explains that skillswiki: refs need the Skills Wiki key step", async () => {
    await expect(loadSolutionSource("skillswiki:pack/skill/recipe.json")).rejects.toThrow(/Skills Wiki key step/);
  });
});
