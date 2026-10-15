import { afterEach, describe, expect, it } from "vitest";
import { deployRelay } from "../../src/core/whatsapp-deploy.js";
import { RELAY_SHA256, pullRelay } from "../../src/core/whatsapp.js";
import { CF_TOKEN, startFakeWhatsApp, textPayload, type FakeWhatsApp } from "../helpers/fake-whatsapp.js";

const fakes: FakeWhatsApp[] = [];
afterEach(() => fakes.splice(0).forEach((fake) => fake.stop()));
async function fake(extra: Record<string, string> = {}) {
  const started = await startFakeWhatsApp(extra);
  fakes.push(started);
  return started;
}
const SECRETS = { verify_token: "v".repeat(32), pull_token: "p".repeat(48), path_key: "k".repeat(32) };

describe("putting the relay into the client's own Cloudflare account (D149)", () => {
  it("creates the database and its table, uploads exactly the pinned relay with its secrets, and switches on its address", async () => {
    const cf = await fake();
    const deployed = await deployRelay(CF_TOKEN, { secrets: SECRETS, keep: false }, cf.env);
    expect(deployed).toEqual({ relay_url: "https://taskfollow-whatsapp.sam.workers.dev", callback_url: `https://taskfollow-whatsapp.sam.workers.dev/webhook/${SECRETS.path_key}`, account: "Sam's account" });
    const seen = await cf.cloudflare();
    expect(seen.databases).toEqual([{ uuid: "db-1", name: "taskfollow-whatsapp" }]);
    expect(seen.queries.join("\n")).toContain("create table if not exists inbox");
    expect(seen.module_sha256).toBe(RELAY_SHA256);
    expect(seen.module_type).toBe("application/javascript+module");
    expect(seen.bindings).toEqual([{ type: "d1", name: "DB", database_id: "db-1" }, { type: "secret_text", name: "VERIFY_TOKEN" }, { type: "secret_text", name: "PULL_TOKEN" }, { type: "secret_text", name: "PATH_KEY" }]);
    expect(seen.enabled).toBe(true);
  });

  it("works end to end: Meta's delivery reaches the relay under the deployed secrets and is pulled with the new pull token", async () => {
    const cf = await fake();
    const deployed = await deployRelay(CF_TOKEN, { secrets: SECRETS, keep: false }, cf.env);
    await cf.deliver(textPayload({ id: "wamid.deployed" }));
    const items = await pullRelay(deployed.relay_url, SECRETS.pull_token, 0, cf.env);
    expect(Buffer.from(items.at(-1)?.body_b64 ?? "", "base64").toString()).toContain("wamid.deployed");
  });

  it("on a second run reuses the database and keeps the secrets Meta already has", async () => {
    const cf = await fake();
    await deployRelay(CF_TOKEN, { secrets: SECRETS, keep: false }, cf.env);
    await deployRelay(CF_TOKEN, { secrets: SECRETS, keep: true }, cf.env);
    const seen = await cf.cloudflare();
    expect(seen.databases).toHaveLength(1);
    expect(seen.uploads).toBe(2);
    expect(seen.keep_bindings).toEqual(["secret_text"]);
    expect(seen.bindings).toEqual([{ type: "d1", name: "DB", database_id: "db-1" }]);
  });

  it("makes a workers.dev address when the account has none yet", async () => {
    const cf = await fake({ FAKE_CF_NO_SUBDOMAIN: "1" });
    const deployed = await deployRelay(CF_TOKEN, { secrets: SECRETS, keep: false }, cf.env);
    expect(deployed.relay_url).toMatch(/^https:\/\/taskfollow-whatsapp\.tf-[a-z0-9]{8}\.workers\.dev$/);
  });

  it("says plainly when the Cloudflare token is wrong, never repeating it", async () => {
    const cf = await fake();
    const message = await deployRelay("cf-secret-wrong", { secrets: SECRETS, keep: false }, cf.env).then(() => "", (error: Error) => error.message);
    expect(message).toMatch(/Cloudflare did not accept the token/);
    expect(message).not.toContain("cf-secret-wrong");
  });
});
