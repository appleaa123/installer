import { afterEach, describe, expect, it } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { InputError } from "../../src/core/inputs.js";
import { headlessHint, openBrowser, startSecretPage, type SecretPage } from "../../src/core/secret-page.js";
import { formHeaders, request } from "../helpers/http.js";

const pages: SecretPage[] = [];
const stored: string[] = [];

async function page(store: (value: string) => Promise<void> = async (value) => void stored.push(value), ttlMs?: number): Promise<SecretPage> {
  const started = await startSecretPage({ id: "skillswiki", store, ...(ttlMs ? { ttlMs } : {}) });
  pages.push(started);
  return started;
}

const originOf = (url: string): string => new URL(url).origin;

afterEach(() => {
  pages.splice(0).forEach((open) => open.close());
  stored.splice(0);
});

describe("the secret page", () => {
  it("serves a password form on its one-time path, uncached", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const reply = await request(url);
    expect(reply.status).toBe(200);
    expect(reply.text).toContain('<input type="password" name="value" autocomplete="off"');
    expect(reply.text).toContain("<code>skillswiki</code>");
  });

  it("stores one submitted value, says done, then stops serving (Review Focus 1)", async () => {
    const { url, done } = await page();
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=%20sw_live_123%20" });
    expect(reply.status).toBe(200);
    expect(reply.text).toContain("Done, you can close this tab.");
    expect(stored).toEqual([" sw_live_123 "]);
    await expect(done).resolves.toBe("stored");
    await expect(request(url)).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([
    ["a wrong token", (url: string) => ({ url: `${originOf(url)}/s/${"0".repeat(64)}`, headers: formHeaders(originOf(url)) }), 404],
    ["a foreign Host header", (url: string) => ({ url, headers: { ...formHeaders(originOf(url)), Host: "evil.test" } }), 403],
    ["a foreign Origin", (url: string) => ({ url, headers: formHeaders("http://evil.test") }), 403],
    ["no Origin at all", (url: string) => ({ url, headers: { "Content-Type": "application/x-www-form-urlencoded" } }), 403],
  ])("refuses a POST with %s and stores nothing (Review Focus 1)", async (_name, make, status) => {
    const { url } = await page();
    const target = make(url);
    const reply = await request(target.url, { method: "POST", headers: target.headers, body: "value=leak" });
    expect(reply.status).toBe(status);
    expect(stored).toEqual([]);
    expect((await request(url)).status).toBe(200);
  });

  it("shows the form again with the reason when the value is refused, and stays open", async () => {
    const { url } = await page(async (value) => {
      if (value.trim() === "") throw new InputError("The secret is empty");
    });
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=" });
    expect(reply.status).toBe(400);
    expect(reply.text).toContain("The secret is empty");
    expect(reply.text).toContain("<form");
    expect((await request(url)).status).toBe(200);
  });

  it("reports a keychain failure as a server error and stays open", async () => {
    const { url } = await page(async () => {
      throw new ActionFailure("The keychain could not store 'skillswiki' (exit 1)");
    });
    const reply = await request(url, { method: "POST", headers: formHeaders(originOf(url)), body: "value=k" });
    expect(reply.status).toBe(500);
    expect(reply.text).toContain("The keychain could not store");
  });

  it("expires unused after its time to live", async () => {
    const { url, done } = await page(undefined, 100);
    await expect(done).resolves.toBe("expired");
    await expect(request(url)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("browser and headless host", () => {
  it("prints an ssh tunnel hint over ssh (D47 headless host)", () => {
    const hint = headlessHint("http://127.0.0.1:4321/s/abc", { SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" });
    expect(hint).toBe("This machine has no browser: from your laptop run 'ssh -L 4321:127.0.0.1:4321 <user>@<this host>', then open http://127.0.0.1:4321/s/abc there");
  });

  it("gives no hint on a desktop", () => {
    expect(headlessHint("http://127.0.0.1:4321/s/abc", { DISPLAY: ":0" })).toBeUndefined();
  });

  it("opens nothing when INSTALLER_BROWSER is none", () => {
    expect(openBrowser("http://127.0.0.1:1/s/x", { INSTALLER_BROWSER: "none" })).toBe(false);
  });

  describe("on Windows (D128, Preview)", () => {
    const url = "http://127.0.0.1:4321/s/abc?x=1&y=2";
    const launcher = () => {
      const launched: { command: string; args: readonly string[] }[] = [];
      const child = { on: () => child, unref: () => undefined };
      const launch = ((command: string, args: readonly string[]) => (launched.push({ command, args }), child)) as unknown as typeof import("node:child_process").spawn;
      return { launched, launch };
    };

    it("opens the default browser with rundll32, without a shell, so an & in the address is safe", () => {
      const { launched, launch } = launcher();
      expect(openBrowser(url, {}, "win32", launch)).toBe(true);
      expect(launched).toEqual([{ command: "rundll32", args: ["url.dll,FileProtocolHandler", url] }]);
    });

    it("still lets INSTALLER_BROWSER choose the opener or turn it off", () => {
      const { launched, launch } = launcher();
      expect(openBrowser(url, { INSTALLER_BROWSER: "none" }, "win32", launch)).toBe(false);
      expect(openBrowser(url, { INSTALLER_BROWSER: "my-browser" }, "win32", launch)).toBe(true);
      expect(launched).toEqual([{ command: "my-browser", args: [url] }]);
    });

    it("leaves macOS and Linux as they were", () => {
      const { launched, launch } = launcher();
      openBrowser(url, {}, "darwin", launch);
      openBrowser(url, {}, "linux", launch);
      expect(launched.map((entry) => entry.command)).toEqual(["open", "xdg-open"]);
    });
  });

  it("survives an opener that does not exist", () => {
    expect(openBrowser("http://127.0.0.1:1/s/x", { INSTALLER_BROWSER: "installer-test-no-such-browser" })).toBe(true);
  });
});
