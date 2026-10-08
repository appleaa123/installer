#!/usr/bin/env node
// Test double for a headless agent CLI (shaped like `claude -p … --output-format json` and `claude mcp …`).
// FAKE_AGENT_DROP switches off one capability: c4 | json | schema | c5 | hang | mcp | trust.
// FAKE_AGENT_HOME: where sessions and MCP registrations live (default ./.fake-agent in the working folder).
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const drop = process.env.FAKE_AGENT_DROP ?? "";
const store = process.env.FAKE_AGENT_HOME ?? join(process.cwd(), ".fake-agent");
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const mcpFile = (name) => join(store, "mcp", `${name}.json`);

function answer(prompt, resumed, session) {
  const exact = /Reply with exactly this word: (\S+)/.exec(prompt);
  if (exact) return exact[1];
  if (!resumed) return "OK";
  try {
    return readFileSync(join(store, `${session}.txt`), "utf8");
  } catch {
    return "I do not know";
  }
}

// `mcp add-json -s <scope> <name> <json>` | `mcp get <name>` | `mcp remove [-s <scope>] <name>` (fact 3: no silent replace).
function mcp([command, ...rest]) {
  const [name, json] = rest.filter((part, index) => part !== "-s" && rest[index - 1] !== "-s");
  mkdirSync(join(store, "mcp"), { recursive: true });
  if (command === "add-json") {
    if (drop === "mcp") process.exit(1);
    if (existsSync(mcpFile(name))) {
      process.stdout.write(`MCP server ${name} already exists in user config\n`);
      process.exit(1);
    }
    writeFileSync(mcpFile(name), json);
    return process.stdout.write(`Added HTTP MCP server ${name} to user config\n`);
  }
  if (!existsSync(mcpFile(name))) {
    process.stdout.write(`No MCP server named "${name}"\n`);
    process.exit(1);
  }
  if (command === "get") return process.stdout.write(readFileSync(mcpFile(name), "utf8"));
  rmSync(mcpFile(name));
  process.stdout.write(`Removed MCP server ${name}\n`);
}

// The C6 rehearsal (fact 4): run the stored headersHelper through the shell, then call the tool over MCP.
async function callTool(name) {
  if (!(valueOf("--allowedTools") ?? "").includes(`mcp__${name}__get_active_combo`)) return "That tool is not allowed";
  if (!existsSync(mcpFile(name))) return `No MCP server named ${name}`;
  if (drop === "trust") return "headersHelper not run: this workspace has no persisted trust";
  try {
    const config = JSON.parse(readFileSync(mcpFile(name), "utf8"));
    const headers = JSON.parse(execSync(config.headersHelper, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    const post = (body, session) =>
      fetch(config.url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
        body: JSON.stringify(body),
      });
    const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "9.9.9" } } });
    const session = init.headers.get("mcp-session-id");
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    const reply = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_active_combo", arguments: {} } }, session)).text();
    const data = reply.split("\n").find((line) => line.startsWith("data:")) ?? "data: {}";
    return String(JSON.parse(data.slice("data:".length)).result?.structuredContent?.combo_slug ?? "null");
  } catch (error) {
    return `Could not call the tool: ${error.message}`;
  }
}

async function main() {
  if (args[0] === "--version") return process.stdout.write("9.9.9 (Fake Agent)\n");
  if (args[0] === "mcp") return mcp(args.slice(1));
  if (drop === "c4") process.exit(1);
  if (drop === "hang") return setInterval(() => undefined, 1000);
  const prompt = valueOf("-p") ?? "";
  const resumed = valueOf("-r");
  const session = resumed && drop !== "c5" ? resumed : randomUUID();
  mkdirSync(store, { recursive: true });
  const remember = /Remember this word: (\S+?)\./.exec(prompt);
  if (remember) writeFileSync(join(store, `${session}.txt`), remember[1]);
  const tool = /Call the tool mcp__([a-z0-9-]+)__get_active_combo/.exec(prompt);
  const result = tool ? await callTool(tool[1]) : answer(prompt, resumed, session);
  const field = /in the field word: (\S+)/.exec(prompt);
  const structured = valueOf("--json-schema") && drop !== "schema" ? { structured_output: { word: field ? field[1] : result } } : {};
  const out = { result, session_id: session, is_error: false, ...structured };
  process.stdout.write(drop === "json" ? "this is not json" : JSON.stringify(out));
}

await main();
