import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RELAY_SHA256 } from "../../src/core/whatsapp.js";
import { startRelay } from "../helpers/relay-shim.js";

const SECRETS = { VERIFY_TOKEN: "verify-123", PULL_TOKEN: "pull-456", PATH_KEY: "0123456789abcdef0123456789abcdef" };
const HOOK = `/webhook/${SECRETS.PATH_KEY}`;
const AUTH = { authorization: `Bearer ${SECRETS.PULL_TOKEN}` };
const post = (relay: Awaited<ReturnType<typeof startRelay>>, body: string | Buffer, signature = "sha256=abc") => relay.call("POST", HOOK, { headers: { "x-hub-signature-256": signature, "content-type": "application/json" }, body });
const pull = async (relay: Awaited<ReturnType<typeof startRelay>>, after = 0) => (await (await relay.call("GET", `/pull?after=${after}`, { headers: AUTH })).json()) as { items: { id: number; body_b64: string; signature: string; received_at: number }[] };

describe("the WhatsApp relay in the client's Cloudflare account (D149)", () => {
  it("is shipped exactly as pinned", async () => {
    expect(createHash("sha256").update(await readFile("relay/whatsapp-relay.mjs")).digest("hex")).toBe(RELAY_SHA256);
  });

  it("answers Meta's handshake with the challenge only for the right token and path", async () => {
    const relay = await startRelay(SECRETS);
    const ok = await relay.call("GET", `${HOOK}?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=777`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    expect((await relay.call("GET", `${HOOK}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=777`)).status).toBe(403);
    expect((await relay.call("GET", `/webhook/guess?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=777`)).status).toBe(404);
    expect((await relay.call("GET", "/")).status).toBe(404);
  });

  it("keeps the exact bytes and the signature of each delivery, and hands them out only with the pull token", async () => {
    const relay = await startRelay(SECRETS);
    const bytes = Buffer.from('{"text":"café ÿ\u0000 end"}', "utf8");
    expect((await post(relay, bytes, "sha256=deadbeef")).status).toBe(200);
    expect((await relay.call("GET", "/pull?after=0")).status).toBe(401);
    expect((await relay.call("GET", "/pull?after=0", { headers: { authorization: "Bearer pull-45" } })).status).toBe(401);
    const { items } = await pull(relay);
    expect(items).toHaveLength(1);
    expect(Buffer.from(items[0]?.body_b64 ?? "", "base64").equals(bytes)).toBe(true);
    expect(items[0]?.signature).toBe("sha256=deadbeef");
  });

  it("forgets what was pulled once the next pull says so, in order, 50 at a time", async () => {
    const relay = await startRelay(SECRETS);
    for (let index = 0; index < 60; index += 1) await post(relay, `{"n":${index}}`);
    const first = await pull(relay, 0);
    expect(first.items).toHaveLength(50);
    expect(first.items.map((item) => item.id)).toEqual([...first.items.map((item) => item.id)].sort((a, b) => a - b));
    const last = first.items.at(-1)?.id ?? 0;
    const second = await pull(relay, last);
    expect(second.items).toHaveLength(10);
    expect(Number(relay.db.prepare("select count(*) c from inbox").get()?.c)).toBe(10);
  });

  it("refuses a delivery that is too large, and asks Meta to retry when too much waits", async () => {
    const relay = await startRelay(SECRETS);
    expect((await post(relay, Buffer.alloc(1_400_001, 97))).status).toBe(413);
    relay.db.exec("insert into inbox (id, body, size, signature, received_at) values (1, 'e30=', 2, 's', 0)");
    relay.db.exec("insert into inbox (id, body, size, signature, received_at) values (5001, 'e30=', 2, 's', 0)");
    expect((await post(relay, "{}")).status).toBe(503);
  });

  it("deletes what nobody pulled after 72 hours", async () => {
    let now = Date.parse("2026-10-15T00:00:00Z");
    const relay = await startRelay(SECRETS, () => now);
    await post(relay, '{"old":true}');
    now += 73 * 3_600_000;
    await post(relay, '{"new":true}');
    const { items } = await pull(relay, 0);
    expect(items.map((item) => Buffer.from(item.body_b64, "base64").toString())).toEqual(['{"new":true}']);
  });

  it("does not answer anything else", async () => {
    const relay = await startRelay(SECRETS);
    expect((await relay.call("PUT", HOOK, { body: "{}" })).status).toBe(404);
    expect((await relay.call("POST", "/pull?after=0", { headers: AUTH })).status).toBe(404);
  });
});
