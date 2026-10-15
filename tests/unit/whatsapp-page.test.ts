import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SecretPage } from "../../src/core/secret-page.js";
import { startWhatsAppPage } from "../../src/core/whatsapp-page.js";
import { CF_TOKEN, WA, startFakeWhatsApp, textPayload, type FakeWhatsApp } from "../helpers/fake-whatsapp.js";
import { formHeaders, request } from "../helpers/http.js";

let fake: FakeWhatsApp;
const pages: SecretPage[] = [];
beforeAll(async () => {
  fake = await startFakeWhatsApp();
});
afterAll(() => fake.stop());
afterEach(() => pages.splice(0).forEach((open) => open.close()));

async function page(existing: Record<string, string> | null = null, ttlMs?: number) {
  const stored: [string, string][] = [];
  const started = await startWhatsAppPage({
    store: async (id, value) => void stored.push([id, value]),
    existing: async () => (existing ? JSON.stringify(existing) : null),
    env: fake.env,
    waitMs: 3000,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  pages.push(started);
  return { url: started.url, stored, done: started.done };
}
const post = (url: string, fields: Record<string, string>) => request(url, { method: "POST", headers: formHeaders(new URL(url).origin), body: new URLSearchParams(fields).toString() });
const META = { access_token: WA.token, app_secret: WA.secret, phone_number_id: WA.phone_id };

describe("the WhatsApp setup page (D149)", () => {
  it("starts with the Cloudflare step, on a one-time path, and explains what passes through whom", async () => {
    const { url } = await page();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/s\/[0-9a-f]{64}$/);
    const first = await request(url);
    expect(first.text).toContain('<input type="password" name="cloudflare_token"');
    expect(first.text).toContain("Workers Scripts");
    expect(first.text).toMatch(/72 hours/);
  });

  it("deploys the relay, then shows the address and verify token to paste into Meta", async () => {
    const { url } = await page();
    const second = await post(url, { step: "cloudflare", cloudflare_token: CF_TOKEN });
    expect(second.status).toBe(200);
    expect(second.text).toMatch(/https:\/\/taskfollow-whatsapp\.sam\.workers\.dev\/webhook\/[0-9a-f]{32}/);
    expect(second.text).toMatch(/[0-9a-f]{32}/);
    expect(second.text).toContain('name="access_token"');
    expect(second.text).not.toContain(CF_TOKEN);
  });

  it("checks the Meta details, waits for one real signed message, then stores everything and says Connected", async () => {
    const { url, stored, done } = await page();
    await post(url, { step: "cloudflare", cloudflare_token: CF_TOKEN });
    const third = await post(url, { step: "meta", ...META });
    expect(third.text).toContain("+1 555 0100");
    expect(third.text).toContain("Check");
    const nothing = await post(url, { step: "check" });
    expect(nothing.text).toMatch(/No message has arrived yet/);
    await fake.deliver(textPayload({ id: "wamid.setup", text: "hello" }));
    const connected = await post(url, { step: "check" });
    expect(connected.text).toContain("Connected");
    expect(stored.map(([id]) => id)).toEqual(["whatsapp", "whatsapp-settings"]);
    const secrets = JSON.parse(stored[0]?.[1] ?? "{}") as Record<string, string>;
    expect(secrets).toMatchObject({ access_token: WA.token, app_secret: WA.secret });
    expect(Object.keys(secrets).sort()).toEqual(["access_token", "app_secret", "path_key", "pull_token", "verify_token"]);
    expect(JSON.parse(stored[1]?.[1] ?? "{}")).toEqual({ relay_url: "https://taskfollow-whatsapp.sam.workers.dev", phone_number_id: WA.phone_id, display_number: "+1 555 0100" });
    await expect(done).resolves.toBe("stored");
  });

  it("never keeps a message that is not really from Meta as the proof", async () => {
    const { url } = await page();
    await post(url, { step: "cloudflare", cloudflare_token: CF_TOKEN });
    await post(url, { step: "meta", ...META });
    await fake.deliver(textPayload({ id: "wamid.forged" }), "wrong");
    expect((await post(url, { step: "check" })).text).toMatch(/No message has arrived yet|signature/);
  });

  it("explains a wrong Meta token in plain words and stores nothing", async () => {
    const { url, stored } = await page();
    await post(url, { step: "cloudflare", cloudflare_token: CF_TOKEN });
    const refused = await post(url, { step: "meta", ...META, access_token: "EAAwrong-secret" });
    expect(refused.status).toBe(400);
    expect(refused.text).not.toContain("EAAwrong-secret");
    expect(stored).toEqual([]);
  });

  it("keeps the relay's secrets on a second setup, so the address in Meta still works", async () => {
    const { url } = await page({ access_token: "old", app_secret: "old", pull_token: "p".repeat(48), verify_token: "v".repeat(32), path_key: "k".repeat(32) });
    const second = await post(url, { step: "cloudflare", cloudflare_token: CF_TOKEN });
    expect(second.text).toContain(`/webhook/${"k".repeat(32)}`);
    expect((await fake.cloudflare()).keep_bindings).toEqual(["secret_text"]);
  });

  it("refuses a foreign Host, an unknown path, a post from another origin, and a step out of order", async () => {
    const { url } = await page();
    expect((await request(url, { headers: { Host: "evil.example" } })).status).toBe(403);
    expect((await request(`${new URL(url).origin}/s/${"0".repeat(64)}`)).status).toBe(404);
    expect((await request(url, { method: "POST", headers: formHeaders("http://evil.example"), body: "step=cloudflare" })).status).toBe(403);
    expect((await post(url, { step: "check" })).status).toBe(400);
  });
});
