#!/usr/bin/env node
// Test double for Meta's WhatsApp Cloud API (Graph) and the client's relay, in one process. The relay part runs the
// REAL relay file (relay/whatsapp-relay.mjs) over node:sqlite, so pulls exercise its SQL. Prints {"url": …} once listening.
// Graph (Authorization: Bearer FAKE_WA_TOKEN): GET /v25.0/<phone id> | POST /v25.0/<phone id>/messages (to "CLOSED" or
// recipient "CLOSED" answers Meta's 131047; to "BADTOKEN" answers 190).
// Relay: GET|POST /webhook/<FAKE_WA_PATH_KEY>, GET /pull (Bearer FAKE_WA_PULL).
// Debug (no auth): POST /debug/deliver {payload, sign: "good"|"wrong"|"none"} posts a delivery to the relay the way Meta
// does (signature = HMAC-SHA256 with FAKE_WA_SECRET); GET /debug/sent; GET /debug/pulls.
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TOKEN = process.env.FAKE_WA_TOKEN ?? "EAAfake-token";
const SECRET = process.env.FAKE_WA_SECRET ?? "app-secret-fake";
const PHONE_ID = process.env.FAKE_WA_PHONE_ID ?? "1098765";
const env = { VERIFY_TOKEN: process.env.FAKE_WA_VERIFY ?? "verify-fake", PULL_TOKEN: process.env.FAKE_WA_PULL ?? "pull-fake", PATH_KEY: process.env.FAKE_WA_PATH_KEY ?? "a".repeat(32) };
const relay = await import(pathToFileURL(resolve(process.env.FAKE_WA_RELAY ?? "relay/whatsapp-relay.mjs")).href);
const db = new DatabaseSync(":memory:");
for (const sql of relay.SCHEMA) db.exec(sql);
env.DB = {
  prepare(sql) {
    let args = [];
    const statement = {
      bind: (...values) => ((args = values), statement),
      run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
      all: async () => ({ success: true, results: db.prepare(sql).all(...args) }),
      first: async (column) => {
        const row = db.prepare(sql).get(...args);
        return row === undefined ? null : column ? row[column] : row;
      },
    };
    return statement;
  },
};
const sent = [];
// Cloudflare (Authorization: Bearer FAKE_CF_TOKEN): accounts, D1, the script upload (multipart), workers.dev. An upload's
// secret_text bindings become the relay's secrets here, unless keep_bindings keeps the old ones. FAKE_CF_NO_SUBDOMAIN=1:
// the account has no workers.dev subdomain until one is PUT. GET /debug/cloudflare reports what happened.
const CF_TOKEN = process.env.FAKE_CF_TOKEN ?? "cf-fake-token";
const cf = { databases: [], queries: [], uploads: 0, module_sha256: "", module_type: "", keep_bindings: null, enabled: false, subdomain: process.env.FAKE_CF_NO_SUBDOMAIN === "1" ? null : "sam" };
let pulls = 0;
let port = 0;

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readRaw = (req) =>
  new Promise((done) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks)));
  });

async function toRelay(req, res, raw) {
  const response = await relay.default.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body: raw } : {}) }), env);
  res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "text/plain" });
  res.end(Buffer.from(await response.arrayBuffer()));
}

function graphError(res, code, message) {
  json(res, 400, { error: { message, type: "OAuthException", code, fbtrace_id: "trace" } });
}

const cfOk = (res, result) => json(res, 200, { success: true, errors: [], messages: [], result });
const cfFail = (res, status, code, message) => json(res, status, { success: false, errors: [{ code, message }], messages: [], result: null });

function multipart(req, raw) {
  const boundary = /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "")?.[1]?.replace(/"/g, "");
  const parts = {};
  for (const chunk of raw.toString("latin1").split(`--${boundary}`).slice(1, -1)) {
    const [head, ...rest] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";
    if (name) parts[name] = { type, body: Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1") };
  }
  return parts;
}

async function cloudflare(req, res, path, raw) {
  if ((req.headers.authorization ?? "") !== `Bearer ${CF_TOKEN}`) return cfFail(res, 403, 10000, "Authentication error");
  const account = "/client/v4/accounts/acc1";
  if (req.method === "GET" && path === "/client/v4/accounts") return cfOk(res, [{ id: "acc1", name: "Sam's account" }]);
  if (req.method === "GET" && path === `${account}/d1/database`) return cfOk(res, cf.databases);
  if (req.method === "POST" && path === `${account}/d1/database`) {
    const { name } = JSON.parse(raw.toString("utf8"));
    const created = { uuid: `db-${cf.databases.length + 1}`, name };
    cf.databases.push(created);
    return cfOk(res, created);
  }
  if (req.method === "POST" && /\/d1\/database\/[^/]+\/query$/.test(path)) {
    cf.queries.push(JSON.parse(raw.toString("utf8")).sql);
    return cfOk(res, [{ success: true, results: [] }]);
  }
  if (req.method === "PUT" && path === `${account}/workers/scripts/taskfollow-whatsapp`) {
    const parts = multipart(req, raw);
    const metadata = JSON.parse(parts.metadata?.body.toString("utf8") ?? "{}");
    const module = parts[metadata.main_module];
    if (!module) return cfFail(res, 400, 10021, "No such module");
    cf.uploads += 1;
    cf.module_type = module.type;
    cf.module_sha256 = (await import("node:crypto")).createHash("sha256").update(module.body).digest("hex");
    cf.keep_bindings = metadata.keep_bindings ?? null;
    for (const binding of metadata.bindings ?? []) if (binding.type === "secret_text") env[binding.name] = binding.text;
    cf.bindings = (metadata.bindings ?? []).map((binding) => ({ type: binding.type, name: binding.name, ...(binding.database_id ? { database_id: binding.database_id } : {}) }));
    return cfOk(res, { id: "taskfollow-whatsapp" });
  }
  if (req.method === "GET" && path === `${account}/workers/subdomain`) return cf.subdomain ? cfOk(res, { subdomain: cf.subdomain }) : cfFail(res, 404, 10007, "This account does not have a workers.dev subdomain");
  if (req.method === "PUT" && path === `${account}/workers/subdomain`) {
    cf.subdomain = JSON.parse(raw.toString("utf8")).subdomain;
    return cfOk(res, { subdomain: cf.subdomain });
  }
  if (req.method === "POST" && path === `${account}/workers/scripts/taskfollow-whatsapp/subdomain`) {
    cf.enabled = JSON.parse(raw.toString("utf8")).enabled === true;
    return cfOk(res, { enabled: cf.enabled });
  }
  return cfFail(res, 404, 7003, "Could not route");
}

const server = createServer(async (req, res) => {
  const raw = await readRaw(req);
  const path = new URL(req.url, "http://x").pathname;
  if (path.startsWith("/webhook/") || path === "/pull") {
    if (path === "/pull") pulls += 1;
    return toRelay(req, res, raw);
  }
  if (path === "/debug/deliver") {
    const { payload, sign = "good" } = JSON.parse(raw.toString("utf8"));
    const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
    const key = sign === "wrong" ? "not-the-secret" : SECRET;
    const headers = sign === "none" ? {} : { "x-hub-signature-256": `sha256=${createHmac("sha256", key).update(body).digest("hex")}` };
    const response = await relay.default.fetch(new Request(`http://127.0.0.1:${port}/webhook/${env.PATH_KEY}`, { method: "POST", headers, body }), env);
    return json(res, 200, { status: response.status });
  }
  if (path === "/debug/sent") return json(res, 200, sent);
  if (path === "/debug/cloudflare") return json(res, 200, cf);
  if (path.startsWith("/client/v4/")) return cloudflare(req, res, path, raw);
  if (path === "/debug/pulls") return json(res, 200, { pulls });
  if ((req.headers.authorization ?? "") !== `Bearer ${TOKEN}`) return graphError(res, 190, "Invalid OAuth access token");
  if (req.method === "GET" && path === `/v25.0/${PHONE_ID}`) return json(res, 200, { display_phone_number: "+1 555 0100", verified_name: "Fake Shop", id: PHONE_ID });
  if (req.method === "POST" && path === `/v25.0/${PHONE_ID}/messages`) {
    const body = JSON.parse(raw.toString("utf8"));
    const target = body.to ?? body.recipient;
    if (target === "CLOSED") return graphError(res, 131047, "Re-engagement message");
    sent.push(body);
    return json(res, 200, { messaging_product: "whatsapp", messages: [{ id: `wamid.out${sent.length}` }] });
  }
  return graphError(res, 100, "Unsupported request");
});
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
});
