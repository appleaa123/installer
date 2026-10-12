import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadConnector, type ConnectorDef } from "../../src/core/connectors.js";
import { startOAuthPage } from "../../src/core/oauth-page.js";
import type { SecretPage } from "../../src/core/secret-page.js";
import { SolutionError, parseSolution } from "../../src/core/solution.js";
import { startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { formHeaders, request } from "../helpers/http.js";

let fake: FakeGoogle;
let def: ConnectorDef;
const pages: SecretPage[] = [];
const stored: string[] = [];

beforeAll(async () => {
  fake = await startFakeGoogle();
  def = await loadConnector("google-sheets", "1");
});

afterAll(() => fake.stop());

afterEach(() => {
  pages.splice(0).forEach((open) => open.close());
  stored.splice(0);
});

async function page(): Promise<SecretPage> {
  const started = await startOAuthPage({ def, store: async (value) => void stored.push(value), env: fake.env });
  pages.push(started);
  return started;
}

const CLIENT = "client_id=client-1&client_secret=secret-1";

/** Posts the client and follows nothing: returns where the page sends the browser. */
async function consentUrl(url: string, body = CLIENT): Promise<URL> {
  const reply = await request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body });
  expect(reply.status).toBe(303);
  return new URL(reply.location ?? "");
}

/** What Google does after the person agrees: send the browser back to the redirect URI with a code and the state. */
const callback = (consent: URL, query: string): Promise<{ status: number; text: string }> => request(`${consent.searchParams.get("redirect_uri") ?? ""}?${query}&state=${consent.searchParams.get("state") ?? ""}`);

describe("the OAuth sign-in page (D66)", () => {
  it("asks for the person's own OAuth client on its one-time path", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('name="client_id"');
    expect(reply.text).toContain('<input type="password" name="client_secret"');
    expect(reply.text).toContain("Desktop app");
  });

  it("sends the browser to Google's consent page with PKCE, the spreadsheets scope and a loopback redirect", async () => {
    const { url } = await page();
    const consent = await consentUrl(url);
    expect(consent.origin + consent.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(consent.searchParams.get("redirect_uri")).toBe(`${new URL(url).origin}/`);
    expect(consent.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/spreadsheets");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).toEqual([]);
  });

  it("exchanges Google's code, stores client and refresh token as one keychain value, and stops serving", async () => {
    const { url, done } = await page();
    const reply = await callback(await consentUrl(url), "code=code-1");
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Done, you can close this tab.");
    expect(stored.map((value) => JSON.parse(value) as unknown)).toEqual([{ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1" }]);
    await expect(done).resolves.toBe("stored");
  });

  it.each([
    ["a stale state", (consent: URL) => request(`${consent.searchParams.get("redirect_uri") ?? ""}?code=code-1&state=${"0".repeat(64)}`), 400, "This sign-in link is stale"],
    ["Google's refusal", (consent: URL) => callback(consent, "error=access_denied"), 400, "Google did not grant access (access_denied)"],
    ["a code Google does not accept", (consent: URL) => callback(consent, "code=code-2"), 400, "Google refused the sign-in (invalid_grant)"],
  ])("stores nothing after %s and stays open", async (_name, send, status, message) => {
    const { url } = await page();
    const reply = await send(await consentUrl(url));
    expect(reply.status).toBe(status);
    expect(reply.text).toContain(message);
    expect(stored).toEqual([]);
    expect((await request(url)).status).toBe(200);
  });

  it("shows the setup guide's help when Google refuses the client", async () => {
    const { url } = await page();
    const reply = await callback(await consentUrl(url, "client_id=client-1&client_secret=wrong"), "code=code-1");
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("Google refused the sign-in (invalid_client)");
    expect(reply.text).toContain("Search for: &#34;Google OAuth invalid_client"); // Google's text is HTML-escaped by the page
    expect(reply.text).not.toContain('Search for: "Google');
  });

  it("does not tell a first sign-in about a stored sign-in when the one-time code is refused", async () => {
    const { url } = await page();
    const reply = await callback(await consentUrl(url), "code=not-the-code");
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("Google refused the sign-in (invalid_grant)");
    expect(reply.text).toContain("Search for:");
    expect(reply.text).not.toContain("The stored sign-in");
  });

  it("shows the setup guide's help when the person pressed Deny", async () => {
    const { url } = await page();
    const reply = await callback(await consentUrl(url), "error=access_denied");
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("Google did not grant access (access_denied)");
    expect(reply.text).toContain("Search for:");
  });

  it("refuses a code that arrives before any client was entered", async () => {
    const { url } = await page();
    expect((await request(`${new URL(url).origin}/?code=code-1&state=x`)).status).toBe(400);
    expect(stored).toEqual([]);
  });

  it.each([
    ["a foreign Origin", { ...formHeaders("http://evil.test") }, 403],
    ["a foreign Host", { ...formHeaders("http://127.0.0.1"), Host: "evil.test" }, 403],
  ])("refuses a form post with %s", async (_name, headers, status) => {
    const { url } = await page();
    expect((await request(url, { method: "POST", headers, body: CLIENT })).status).toBe(status);
  });

  it("shows the form again when the client secret is empty", async () => {
    const { url } = await page();
    const reply = await request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: "client_id=client-1&client_secret=" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("The secret is empty");
  });
});

describe("oauth steps in a solution (§8.3)", () => {
  const oauth = (extra: Record<string, unknown>) => ({ id: "s", version: "1", steps: [{ step_id: "data.google", phase: "DATA", type: "human_action", title: "Sign in", why: "Needed.", blocking: true, input: { kind: "oauth", provider: "google" }, ...extra }] });

  it("accepts a sign-in step confirmed by secret_present for its provider", () => {
    expect(parseSolution(oauth({ verify: { check: "secret_present", args: { id: "google" } } })).steps).toHaveLength(1);
  });

  it.each([
    ["no provider", { input: { kind: "oauth" }, verify: { check: "secret_present", args: { id: "google" } } }, "a oauth step needs input.provider"],
    ["no check", {}, "a oauth step must verify with"],
  ])("refuses one with %s", (_name, extra, message) => {
    expect(() => parseSolution(oauth(extra))).toThrow(SolutionError);
    expect(() => parseSolution(oauth(extra))).toThrow(message);
  });
});
