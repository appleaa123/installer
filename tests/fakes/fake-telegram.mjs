#!/usr/bin/env node
// Test double for the Telegram Bot API methods the gateway calls (POST /bot<token>/getMe | getUpdates | sendMessage),
// shaped like Telegram's documented answers. Offline; one process per test file. Prints {"url": …} once listening.
// FAKE_TELEGRAM_TOKEN: the accepted bot token (default 123:fake-token); any other token gets 401 Unauthorized.
// getUpdates long-polls for at most 2 seconds, whatever timeout it is asked for.
// Test-only endpoints, no auth: POST /debug/updates {"from":1001,"text":"…","chat":1001} queues a private text
// message; GET /debug/sent lists the messages the bot sent; GET /debug/calls counts the calls per method.
import { createServer } from "node:http";

const token = process.env.FAKE_TELEGRAM_TOKEN ?? "123:fake-token";
const MAX_POLL_MS = 2000;
let updates = [];
let nextUpdate = 1;
const sent = [];
const calls = {};
let waiting = [];

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
const ok = (res, result) => send(res, 200, { ok: true, result });
const refuse = (res, code, description) => send(res, code, { ok: false, error_code: code, description });

function readBody(req) {
  return new Promise((done) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => done(body ? JSON.parse(body) : {}));
  });
}

function getUpdates(res, body) {
  if (typeof body.offset === "number") updates = updates.filter((update) => update.update_id >= body.offset);
  if (updates.length > 0 || !body.timeout) return ok(res, updates);
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    ok(res, updates);
  };
  const timer = setTimeout(answer, Math.min(body.timeout * 1000, MAX_POLL_MS));
  waiting.push(answer);
}

function api(res, method, body) {
  calls[method] = (calls[method] ?? 0) + 1;
  if (method === "getMe") return ok(res, { id: 999, is_bot: true, first_name: "Desk", username: "desk_test_bot" });
  if (method === "getUpdates") return getUpdates(res, body);
  if (method === "sendMessage") {
    if (String(body.chat_id) === "404") return refuse(res, 400, "Bad Request: chat not found");
    sent.push({ chat_id: String(body.chat_id), text: body.text });
    return ok(res, { message_id: sent.length, chat: { id: Number(body.chat_id) }, text: body.text });
  }
  return refuse(res, 404, "Not Found");
}

function debug(req, res, body) {
  if (req.method === "GET" && req.url === "/debug/sent") return send(res, 200, sent);
  if (req.method === "GET" && req.url === "/debug/calls") return send(res, 200, calls);
  if (req.method === "POST" && req.url === "/debug/updates") {
    const chat = body.chat ?? body.from;
    const update = { update_id: nextUpdate++, message: { message_id: nextUpdate, from: { id: body.from, is_bot: false, first_name: "Test" }, chat: { id: chat, type: "private" }, date: 1791460800, text: body.text } };
    updates.push(update);
    const wake = waiting;
    waiting = [];
    wake.forEach((answer) => answer());
    return send(res, 200, update);
  }
  return send(res, 404, { error: "unknown debug endpoint" });
}

const server = createServer(async (req, res) => {
  const body = req.method === "POST" ? await readBody(req) : {};
  if (req.url?.startsWith("/debug/")) return debug(req, res, body);
  const match = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.url ?? "");
  if (!match) return refuse(res, 404, "Not Found");
  if (match[1] !== token) return refuse(res, 401, "Unauthorized");
  return api(res, match[2], body);
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })}\n`);
});
