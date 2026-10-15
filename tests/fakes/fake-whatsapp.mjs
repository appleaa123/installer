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
