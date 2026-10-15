// TaskFollow's WhatsApp relay (D149). It runs in the client's own free Cloudflare account, never the owner's.
// Meta posts each WhatsApp delivery here; the relay keeps the exact bytes (base64) and Meta's signature until the
// client's own computer pulls them with its pull token. It never holds the Meta access token or the app secret, so
// it cannot read signatures' meaning or send anything: the computer checks every signature itself.
// Secrets: VERIFY_TOKEN (Meta's handshake), PULL_TOKEN (the computer's pulls), PATH_KEY (the unguessable callback path).

const MAX_BYTES = 1_400_000;
const MAX_ROWS = 5_000;
const MAX_TOTAL_BYTES = 50_000_000;
const KEEP_MS = 72 * 3_600_000;
const PAGE = 50;

export const SCHEMA = [
  "create table if not exists inbox (id integer primary key autoincrement, body text not null, size integer not null, signature text not null, received_at integer not null)",
  "create index if not exists inbox_received on inbox (received_at)",
];

function sameSecret(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || expected === "" || given.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= given.charCodeAt(index) ^ expected.charCodeAt(index);
  return diff === 0;
}

function toBase64(bytes) {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

const reply = (status, body = "", type = "text/plain") => new Response(body, { status, headers: { "content-type": type } });

async function handshake(url, env) {
  const ok = url.searchParams.get("hub.mode") === "subscribe" && sameSecret(url.searchParams.get("hub.verify_token") ?? "", env.VERIFY_TOKEN);
  return ok ? reply(200, url.searchParams.get("hub.challenge") ?? "") : reply(403);
}

async function receive(request, env, now) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_BYTES) return reply(413);
  const load = await env.DB.prepare("select min(id) as lo, max(id) as hi, coalesce(sum(size), 0) as bytes from inbox").first();
  if (load && load.hi !== null && (load.hi - load.lo + 1 >= MAX_ROWS || load.bytes + bytes.length > MAX_TOTAL_BYTES)) return reply(503);
  await env.DB.prepare("insert into inbox (body, size, signature, received_at) values (?, ?, ?, ?)")
    .bind(toBase64(bytes), bytes.length, request.headers.get("x-hub-signature-256") ?? "", now)
    .run();
  return reply(200, "ok");
}

async function pull(request, url, env, now) {
  const auth = request.headers.get("authorization") ?? "";
  if (!sameSecret(auth.startsWith("Bearer ") ? auth.slice(7) : "", env.PULL_TOKEN)) return reply(401);
  const after = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
  const done = Number.isFinite(after) && after > 0 ? after : 0;
  if (done > 0) await env.DB.prepare("delete from inbox where id <= ?").bind(done).run();
  await env.DB.prepare("delete from inbox where received_at < ?").bind(now - KEEP_MS).run();
  const rows = await env.DB.prepare("select id, body, signature, received_at from inbox where id > ? order by id limit ?").bind(done, PAGE).all();
  const items = rows.results.map((row) => ({ id: row.id, body_b64: row.body, signature: row.signature, received_at: row.received_at }));
  return reply(200, JSON.stringify({ items }), "application/json");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = typeof env.NOW === "function" ? env.NOW() : Date.now();
    const hook = `/webhook/${env.PATH_KEY}`;
    if (url.pathname === hook && request.method === "GET") return handshake(url, env);
    if (url.pathname === hook && request.method === "POST") return receive(request, env, now);
    if (url.pathname === "/pull" && request.method === "GET") return pull(request, url, env, now);
    return reply(404);
  },
};
