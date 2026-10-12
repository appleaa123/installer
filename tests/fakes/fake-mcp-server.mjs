#!/usr/bin/env node
// Test double for the hosted Skills Wiki MCP server (Streamable HTTP), shaped like the live answers
// observed on 2026-10-08: 401 without the key (403 since 2026-10-12, set FAKE_MCP_REJECT_STATUS=403), SSE answers with an mcp-session-id, 202 for the
// initialized notification, get_active_combo and get_skill_resource results.
// FAKE_MCP_KEY: the accepted Bearer key (default test-key). FAKE_MCP_COMBO: the active combo slug
// (default demo-combo; empty = no combo activated). FAKE_MCP_DIR: folder served as <pack>/<skill>/<path>.
// Learnings (Plan 8): learning_record and learning_list keep learnings in memory per pack; FAKE_MCP_LEARNING=off
// answers learning_record with the error a user without Learning Mode gets.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const key = process.env.FAKE_MCP_KEY ?? "test-key";
const comboSlug = process.env.FAKE_MCP_COMBO ?? "demo-combo";
const resourceDir = process.env.FAKE_MCP_DIR ?? "";
const sessions = new Set();
const learnings = [];

const toolResult = (payload, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError });
const noCombo = { combo: null, combo_slug: null, has_loop: false, learning_mode: false, skills: [], skill_tools: [], skills_not_mounted: [], harness: "" };

function activeCombo() {
  if (!comboSlug) return toolResult(noCombo);
  const combo = { id: "combo-1", name: "Demo combo", slug: comboSlug, kind: "combo", description: "Fixture combo", activated_at: "2026-10-08T00:00:00Z" };
  return toolResult({ ...noCombo, combo, combo_slug: comboSlug, skills: ["demo/install"] });
}

function skillResource({ pack, skill_name: skill, path }) {
  const base = join(resourceDir, pack, skill);
  try {
    if (!path) return toolResult({ resources: readdirSync(base).map((name) => ({ path: name, kind: "reference", size: statSync(join(base, name)).size })) });
    const content = readFileSync(join(base, path), "utf8");
    return toolResult({ path, kind: "reference", content: `<skill_reference>\n${content}\n</skill_reference>` });
  } catch {
    return { content: [{ type: "text", text: `Resource not found: ${pack}/${skill}/${path}` }], isError: true };
  }
}

function learning(name, args) {
  if (name === "learning_list") return toolResult({ pack: args.pack, learnings: learnings.filter((entry) => entry.pack === args.pack) });
  if (process.env.FAKE_MCP_LEARNING === "off") return { content: [{ type: "text", text: "Learning Mode is off: turn it on under Settings to record learnings" }], isError: true };
  if (typeof args.body !== "string" || args.body.length > 600 || !args.pack || !args.skill_slug) return { content: [{ type: "text", text: "body must be at most 600 characters" }], isError: true };
  const entry = { id: learnings.length + 1, pack: args.pack, skill_slug: args.skill_slug, body: args.body, supersedes: args.supersedes ?? null };
  learnings.push(entry);
  return toolResult({ recorded: true, id: entry.id });
}

function callTool(params) {
  if (params.name === "learning_list" || params.name === "learning_record") return { result: learning(params.name, params.arguments ?? {}) };
  if (params.name === "get_active_combo") return { result: activeCombo() };
  if (params.name === "get_skill_resource") return { result: skillResource(params.arguments ?? {}) };
  return { error: { code: -32602, message: `Unknown tool: ${params.name}` } };
}

function answer(req, res, message) {
  if (message.method === "initialize") {
    const session = randomUUID();
    sessions.add(session);
    const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-skills-wiki", version: "0.0.0" } };
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": session });
    return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  }
  if (!sessions.has(req.headers["mcp-session-id"])) {
    res.writeHead(400, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "missing or unknown mcp-session-id" }));
  }
  if (message.method === "notifications/initialized") {
    res.writeHead(202);
    return res.end();
  }
  const body = message.method === "tools/call" ? callTool(message.params ?? {}) : { error: { code: -32601, message: `Unknown method: ${message.method}` } };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n\n`);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(Number(process.env.FAKE_MCP_REJECT_STATUS ?? 401), { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    answer(req, res, JSON.parse(raw));
  });
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/mcp` })}\n`);
});
