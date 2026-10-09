import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConnector, type ConnectorDef } from "../../src/core/connectors.js";
import { ActionFailure } from "../../src/core/failure.js";
import { authorizeUrl, connectorTokens, exchangeCode, parseSignIn, pkcePair } from "../../src/core/google-auth.js";
import { setSecret } from "../../src/core/keychain.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { makeTempHome } from "../helpers/temp-home.js";

let fake: FakeGoogle;
let def: ConnectorDef;

beforeAll(async () => {
  fake = await startFakeGoogle();
  def = await loadConnector("google-sheets", "1");
});

afterAll(() => fake.stop());

/** A private file keychain and the fake server, for one test. */
async function env(signIn?: string): Promise<Record<string, string>> {
  const value = { ...fake.env, INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  if (signIn !== undefined) await setSecret("google", signIn, value);
  return value;
}

const tokenRequests = async (): Promise<number> => ((await fake.debug("/debug/token-requests")) as { count: number }).count;

describe("the stored sign-in", () => {
  it("is the client's own OAuth client plus the refresh token, as one JSON line", () => {
    expect(parseSignIn(SIGNED_IN)).toEqual({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1" });
  });

  it.each([["not JSON", "x"], ["a missing refresh token", JSON.stringify({ client_id: "a", client_secret: "b" })]])("refuses %s", (_name, text) => {
    expect(() => parseSignIn(text)).toThrow("The stored Google sign-in is damaged: run 'installer secret google' to sign in again");
  });
});

describe("connectorTokens (D66: the client's own OAuth app)", () => {
  it("names the command to run when nobody signed in yet", async () => {
    await expect(connectorTokens(def, await env())).rejects.toThrow(ActionFailure);
    await expect(connectorTokens(def, await env())).rejects.toThrow("No Google sign-in is stored yet: run 'installer secret google'");
  });

  it("refreshes an access token once and reuses it until it expires", async () => {
    const before = await tokenRequests();
    const tokens = await connectorTokens(def, await env(SIGNED_IN));
    const first = await tokens.accessToken();
    expect(first).toMatch(/^access-\d+$/);
    await expect(tokens.accessToken()).resolves.toBe(first);
    expect(await tokenRequests()).toBe(before + 1);
  });

  it("says how to sign in again when Google refuses the client", async () => {
    const tokens = await connectorTokens(def, await env(JSON.stringify({ client_id: "client-1", client_secret: "wrong", refresh_token: "refresh-1" })));
    await expect(tokens.accessToken()).rejects.toThrow("Google refused the stored sign-in (invalid_client): run 'installer secret google' to sign in again");
  });

  it("reports an unreachable sign-in service as a fixable failure", async () => {
    const tokens = await connectorTokens(def, { ...(await env(SIGNED_IN)), INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:9", INSTALLER_KEYCHAIN: "file" });
    await expect(tokens.accessToken()).rejects.toThrow(ActionFailure);
    await expect(tokens.accessToken()).rejects.toThrow("Cannot reach Google's sign-in service");
  });
});

describe("the loopback sign-in pieces (D66)", () => {
  it("makes a PKCE pair whose challenge is the base64url sha256 of the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("asks Google's consent page for the spreadsheets scope only, offline access, PKCE and the state", () => {
    const url = new URL(authorizeUrl(def.auth, "client-1", "http://127.0.0.1:5000/", "state-1", "challenge-1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "client-1", redirect_uri: "http://127.0.0.1:5000/", response_type: "code", scope: "https://www.googleapis.com/auth/spreadsheets",
      access_type: "offline", prompt: "consent", state: "state-1", code_challenge: "challenge-1", code_challenge_method: "S256",
    });
  });

  it("exchanges the code for a refresh token", async () => {
    const client = { client_id: "client-1", client_secret: "secret-1" };
    const { verifier } = pkcePair();
    await expect(exchangeCode(def.auth, client, { code: "code-1", redirectUri: "http://127.0.0.1:5000/", verifier }, fake.env)).resolves.toBe("refresh-1");
    await expect(exchangeCode(def.auth, client, { code: "code-2", redirectUri: "http://127.0.0.1:5000/", verifier }, fake.env)).rejects.toThrow("Google refused the sign-in (invalid_grant)");
  });

  it("refuses a sign-in after the person removed the installer's access (Review Focus 4)", async () => {
    const tokens = await connectorTokens(def, await env(SIGNED_IN));
    await fake.debug("/debug/revoke", {});
    await expect(tokens.accessToken()).rejects.toThrow("Google refused the stored sign-in (invalid_grant): run 'installer secret google' to sign in again");
  });
});
