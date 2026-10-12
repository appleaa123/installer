import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ToolRefusal } from "../../src/core/approvals.js";
import { InputError } from "../../src/core/inputs.js";
import { SERVER_INFO, handleLine, serveStdio, type ServerHandlers } from "../../src/core/mcp-server.js";

const TOOLS = [{ name: "demo.read", description: "read", inputSchema: { type: "object" } }];

const handlers: ServerHandlers = {
  list: () => TOOLS,
  call: async (_name, args) => {
    const mode = (args as { mode?: string }).mode;
    if (mode === "refuse") throw new ToolRefusal("demo.read is L2: a person must approve it first");
    if (mode === "usage") throw new InputError("demo.read does not take 'x'");
    if (mode === "crash") throw new TypeError("boom");
    return { ok: true, args };
  },
};

const line = (message: Record<string, unknown>) => handleLine(handlers, JSON.stringify({ jsonrpc: "2.0", ...message }));

describe("local MCP server messages (D56)", () => {
  it.each([["2025-06-18", "2025-06-18"], ["2024-11-05", "2024-11-05"], ["2025-11-25", "2025-06-18"], [undefined, "2025-06-18"]])("answers initialize asking %s with %s", async (asked, given) => {
    const reply = await line({ id: 0, method: "initialize", params: { protocolVersion: asked, capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 0, result: { protocolVersion: given, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: expect.stringContaining("approvals.request") } });
  });

  it("answers server/discover (sent first by Claude Code) with method not found, keeping its string id", async () => {
    await expect(line({ id: "server-discover-probe-1", method: "server/discover", params: {} })).resolves.toEqual({ jsonrpc: "2.0", id: "server-discover-probe-1", error: { code: -32601, message: "Method not found: server/discover" } });
  });

  it("does not answer notifications or the client's own responses", async () => {
    await expect(line({ method: "notifications/initialized" })).resolves.toBeNull();
    await expect(line({ id: 5, result: {} })).resolves.toBeNull();
  });

  it("answers ping and tools/list", async () => {
    await expect(line({ id: 1, method: "ping" })).resolves.toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    await expect(line({ id: 2, method: "tools/list" })).resolves.toEqual({ jsonrpc: "2.0", id: 2, result: { tools: TOOLS } });
  });

  it("returns a tool's result as text and as structured content", async () => {
    await expect(line({ id: 3, method: "tools/call", params: { name: "demo.read", arguments: { a: 1 } } })).resolves.toEqual({
      jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"ok":true,"args":{"a":1}}' }], structuredContent: { ok: true, args: { a: 1 } } },
    });
  });

  it.each([["refuse", "demo.read is L2: a person must approve it first"], ["usage", "demo.read does not take 'x'"], ["crash", "Internal error: boom"]])("turns a %s error into a tool error the model can read", async (mode, text) => {
    await expect(line({ id: 4, method: "tools/call", params: { name: "demo.read", arguments: { mode } } })).resolves.toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text }], isError: true } });
  });

  it.each([
    ["an unknown tool", { name: "demo.write" }, "Unknown tool: demo.write"],
    ["a call without a name", {}, "tools/call needs params.name"],
  ])("refuses %s as invalid params", async (_name, params, message) => {
    await expect(line({ id: 6, method: "tools/call", params })).resolves.toEqual({ jsonrpc: "2.0", id: 6, error: { code: -32602, message } });
  });

  it.each([["not JSON", "{", -32700], ["a batch", "[]", -32600], ["no jsonrpc field", '{"id":1,"method":"ping"}', -32600], ["an object id", '{"jsonrpc":"2.0","id":{},"method":"ping"}', -32600]])("refuses %s", async (_name, raw, code) => {
    await expect(handleLine(handlers, raw)).resolves.toMatchObject({ jsonrpc: "2.0", id: null, error: { code } });
  });
});

describe("serveStdio", () => {
  it("answers each request on its own line, in order, and finishes when input closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const served = serveStdio(handlers, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await served;
    const lines = (output.read() as Buffer).toString("utf8").trim().split("\n").map((text) => JSON.parse(text) as { id: number });
    expect(lines.map((message) => message.id)).toEqual([1, 2]);
  });
});
