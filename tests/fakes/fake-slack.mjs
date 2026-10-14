#!/usr/bin/env node
// Test double for the Slack Web API calls and Socket Mode that the gateway uses, shaped like Slack's documented answers.
// Offline; one process per test file. Prints {"url": …} once listening. No dependency: the WebSocket server is the small
// part of RFC 6455 Socket Mode needs (handshake, unmasked server text frames, masked client frames, ping/close).
// Tokens: FAKE_SLACK_BOT (default xoxb-fake-bot), FAKE_SLACK_APP (default xapp-fake-app).
// Web API (Authorization: Bearer): POST /api/auth.test | apps.connections.open | chat.postMessage. Channel "UNKNOWN" gives
// channel_not_found; channel "RATE" gives one 429 with Retry-After: 0, then works.
// Test-only endpoints, no auth: POST /debug/event {user,text,…} sends an events_api envelope to the live connection (or queues it);
// POST /debug/redeliver sends the last event again with the same ids; POST /debug/disconnect {reason}; POST /debug/drop;
// GET /debug/acks | /debug/sent | /debug/stats.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const BOT = process.env.FAKE_SLACK_BOT ?? "xoxb-fake-bot";
const APP = process.env.FAKE_SLACK_APP ?? "xapp-fake-app";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const sockets = [];
const acks = [];
const sent = [];
const queued = [];
let opens = 0;
let envelopeCount = 0;
let lastEnvelope = null;
let rateLimited = false;
let port = 0;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((done) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => done(body ? JSON.parse(body) : {}));
  });
const bearer = (req) => (req.headers.authorization ?? "").replace(/^Bearer /, "");

function frame(text) {
  const payload = Buffer.from(text, "utf8");
  const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : payload.length < 65536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]) : null;
  if (!head) throw new Error("fake Slack frames are small");
  return Buffer.concat([head, payload]);
}
const sendAll = (message) => sockets.filter((socket) => !socket.destroyed).forEach((socket) => socket.write(frame(JSON.stringify(message))));
const live = () => sockets.filter((socket) => !socket.destroyed);

/** Client frames are masked; returns the decoded text, or a control marker. */
function readFrames(socket, buffer) {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset] & 0x0f;
    let length = buffer[offset + 1] & 0x7f;
    let cursor = offset + 2;
    if (length === 126) { length = buffer.readUInt16BE(cursor); cursor += 2; }
    const mask = buffer.subarray(cursor, cursor + 4);
    cursor += 4;
    if (buffer.length < cursor + length) break;
    const data = Buffer.from(buffer.subarray(cursor, cursor + length).map((byte, index) => byte ^ mask[index % 4]));
    offset = cursor + length;
    if (opcode === 1) { try { const message = JSON.parse(data.toString("utf8")); if (message.envelope_id) acks.push(message.envelope_id); } catch { /* ignore */ } }
    if (opcode === 9) socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
    if (opcode === 8) { socket.write(Buffer.from([0x88, 0])); socket.end(); }
  }
  return buffer.subarray(offset);
}

function api(req, res, method, body) {
  if (method === "auth.test") {
    if (bearer(req) !== BOT) return json(res, 200, { ok: false, error: "invalid_auth" });
    return json(res, 200, { ok: true, url: "https://fake.slack.com/", team: "Fake Team", team_id: "T0TEAM", user: "taskfollow", user_id: "U0BOT", bot_id: "B0BOT" });
  }
  if (method === "apps.connections.open") {
    if (bearer(req) !== APP) return json(res, 200, { ok: false, error: "invalid_auth" });
    opens += 1;
    return json(res, 200, { ok: true, url: `ws://127.0.0.1:${port}/link?ticket=${opens}` });
  }
  if (method === "chat.postMessage") {
    if (bearer(req) !== BOT) return json(res, 200, { ok: false, error: "invalid_auth" });
    if (body.channel === "UNKNOWN") return json(res, 200, { ok: false, error: "channel_not_found" });
    if (body.channel === "RATE" && !rateLimited) { rateLimited = true; return json(res, 429, { ok: false, error: "ratelimited" }, { "retry-after": "0" }); }
    sent.push({ channel: body.channel, text: body.text, parse: body.parse, mrkdwn: body.mrkdwn, unfurl_links: body.unfurl_links, unfurl_media: body.unfurl_media, link_names: body.link_names });
    return json(res, 200, { ok: true, channel: body.channel, ts: `1700000000.${String(sent.length).padStart(6, "0")}` });
  }
  return json(res, 200, { ok: false, error: "unknown_method" });
}

function makeEnvelope(body) {
  envelopeCount += 1;
  const event = { type: "message", channel_type: body.channel_type ?? "im", user: body.user ?? "U0ADA", text: body.text ?? "", channel: body.channel ?? "D0ADA", ts: body.ts ?? `1700000100.${String(envelopeCount).padStart(6, "0")}`, ...(body.subtype ? { subtype: body.subtype } : {}), ...(body.bot_id ? { bot_id: body.bot_id } : {}) };
  return { envelope_id: `env-${envelopeCount}`, type: "events_api", accepts_response_payload: false, payload: { team_id: body.team_id ?? "T0TEAM", api_app_id: body.api_app_id ?? "A0APP", event, type: "event_callback", event_id: `Ev${envelopeCount}` } };
}

function debug(req, res, path, body) {
  if (path === "/debug/event") {
    lastEnvelope = makeEnvelope(body);
    if (live().length > 0) sendAll(lastEnvelope);
    else queued.push(lastEnvelope);
    return json(res, 200, { envelope_id: lastEnvelope.envelope_id, ts: lastEnvelope.payload.event.ts });
  }
  if (path === "/debug/redeliver") {
    if (lastEnvelope) sendAll({ ...lastEnvelope, retry_attempt: 1, retry_reason: "timeout" });
    return json(res, 200, {});
  }
  if (path === "/debug/disconnect") { sendAll({ type: "disconnect", reason: body.reason ?? "warning", debug_info: {} }); return json(res, 200, {}); }
  if (path === "/debug/drop") { live().forEach((socket) => socket.destroy()); return json(res, 200, {}); }
  if (path === "/debug/acks") return json(res, 200, acks);
  if (path === "/debug/sent") return json(res, 200, sent);
  if (path === "/debug/stats") return json(res, 200, { opens, live: live().length, acks: acks.length });
  return json(res, 404, {});
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  const body = req.method === "POST" ? await readBody(req) : {};
  if (path.startsWith("/api/")) return api(req, res, path.slice("/api/".length), body);
  return debug(req, res, path, body);
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key || !req.url?.startsWith("/link")) return socket.destroy();
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.push(socket);
  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => { pending = readFrames(socket, Buffer.concat([pending, chunk])); });
  socket.on("error", () => undefined);
  socket.write(frame(JSON.stringify({ type: "hello", num_connections: live().length, connection_info: { app_id: "A0APP" }, debug_info: { approximate_connection_time: 18060 } })));
  while (queued.length > 0) socket.write(frame(JSON.stringify(queued.shift())));
});

server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
});
