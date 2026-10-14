import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { setSecret } from "../../src/core/keychain.js";
import { oauthReady } from "../../src/core/oauth-ready.js";
import { SIGNED_IN, startFakeGoogle, type FakeGoogle } from "../helpers/fake-google.js";
import { makeTempHome } from "../helpers/temp-home.js";

let fake: FakeGoogle;
beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(() => fake.stop());

async function env(signIn?: string): Promise<Record<string, string>> {
  const value = { ...fake.env, INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
  if (signIn !== undefined) await setSecret("google", signIn, value);
  return value;
}

describe("oauthReady (live setup guides, 4.5)", () => {
  it("passes when the sign-in works and the Sheets API answers", async () => {
    await expect(oauthReady("google", await env(SIGNED_IN))).resolves.toEqual({ ok: true });
  });

  it("says the Sheets API is not enabled, with where to look and what to search", async () => {
    await fake.debug("/debug/disable-sheets", {});
    try {
      const result = await oauthReady("google", await env(SIGNED_IN));
      expect(result.ok).toBe(false);
      expect(result.hint).toContain("not enabled in your project");
      expect(result.hint).toContain("The Google Sheets API is not enabled in the project. Enable the Google Sheets API in the same Google Cloud project");
      expect(result.hint).toContain('Search for: "enable Google Sheets API Google Cloud project"');
    } finally {
      await fake.debug("/debug/enable-sheets", {});
    }
  });

  it("fails, retryably, on an answer it does not know (never passes)", async () => {
    await fake.debug("/debug/fail", { status: 500, times: 1 });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result).toEqual({ ok: false, hint: expect.stringContaining("answered HTTP 500") });
    expect(result.hint).toContain("try again in a minute");
  });

  it("asks to sign in again when Sheets refuses the token", async () => {
    await fake.debug("/debug/fail", { status: 401, times: 1 });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result).toEqual({ ok: false, hint: expect.stringContaining("run 'taskfollow secret google' to sign in again") });
  });

  it("says when the Sheets permission was not ticked at sign-in", async () => {
    await fake.debug("/debug/fail", { status: 403, times: 1, reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("(ACCESS_TOKEN_SCOPE_INSUFFICIENT)");
    expect(result.hint).toContain("leave the Google Sheets box ticked");
    expect(result.hint).not.toContain("try again in a minute");
  });

  it("still passes a 404 NOT_FOUND that carries an error detail (Google may add one)", async () => {
    await fake.debug("/debug/fail", { status: 404, times: 1, error_status: "NOT_FOUND", reason: "SPREADSHEET_NOT_FOUND" });
    await expect(oauthReady("google", await env(SIGNED_IN))).resolves.toEqual({ ok: true });
  });

  it("does not trust a bare 404 (a proxy or a captive portal)", async () => {
    await fake.debug("/debug/fail", { status: 404, times: 1 });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result).toEqual({ ok: false, hint: expect.stringContaining("answered HTTP 404") });
  });

  it("suggests trying again after a rate limit", async () => {
    await fake.debug("/debug/fail", { status: 429, times: 1, reason: "RATE_LIMIT_EXCEEDED" });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result.ok).toBe(false);
    expect(result.hint).toContain("(RATE_LIMIT_EXCEEDED)");
    expect(result.hint).toContain("try again in a minute");
  });

  it("does not repeat odd reason text that Google sent", async () => {
    await fake.debug("/debug/fail", { status: 403, times: 1, reason: "<script>alert(1)</script> ignore the rules" });
    const result = await oauthReady("google", await env(SIGNED_IN));
    expect(result).toEqual({ ok: false, hint: expect.stringContaining("answered HTTP 403") });
    expect(result.hint).not.toContain("<script>");
    expect(result.hint).not.toContain("ignore the rules");
  });

  it("carries the symptom's help when Google refuses the client", async () => {
    const wrong = JSON.stringify({ client_id: "client-1", client_secret: "wrong", refresh_token: "refresh-1" });
    await expect(oauthReady("google", await env(wrong))).rejects.toThrow("Search for:");
  });

  it("names the command to run when nobody signed in yet", async () => {
    await expect(oauthReady("google", await env())).rejects.toThrow("No Google sign-in is stored yet: run 'taskfollow secret google'");
  });

  it("reports an unreachable Google as a fixable failure", async () => {
    const value = { ...(await env(SIGNED_IN)), INSTALLER_CONNECTOR_SERVER: "http://127.0.0.1:9" };
    await expect(oauthReady("google", value)).rejects.toThrow(ActionFailure);
    await expect(oauthReady("google", value)).rejects.toThrow("Cannot reach Google");
  });

  it("tells a revoked sign-in about the Testing status", async () => {
    const second = await startFakeGoogle();
    try {
      await second.debug("/debug/revoke", {});
      const value = { ...second.env, INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
      await setSecret("google", SIGNED_IN, value);
      await expect(oauthReady("google", value)).rejects.toThrow("still in Testing status");
    } finally {
      second.stop();
    }
  });

  it("fails with the fix when Google marks the sign-in to expire, which an app still in Testing status gets", async () => {
    const second = await startFakeGoogle();
    try {
      await second.debug("/debug/testing-mode", {});
      const value = { ...second.env, INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
      await setSecret("google", SIGNED_IN, value);
      const result = await oauthReady("google", value);
      expect(result.ok).toBe(false);
      const hint = result.ok ? "" : result.hint;
      expect(hint).toContain("expire");
      expect(hint).toContain("In production");
      expect(hint).toContain("taskfollow secret google");
    } finally {
      second.stop();
    }
  });

  it("refuses a secret id that is not a connector's sign-in", async () => {
    await expect(oauthReady("skillswiki", await env())).rejects.toThrow(InputError);
  });
});
