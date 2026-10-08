import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionFailure } from "../../src/core/failure.js";
import { KEY_REJECTED_HINT, MCP_MAX_BYTES, callTool } from "../../src/core/mcp.js";
import { startFakeMcp, type FakeMcp } from "../helpers/fake-mcp.js";

const servers: FakeMcp[] = [];

async function server(env: Record<string, string> = {}): Promise<FakeMcp> {
  const started = await startFakeMcp(env);
  servers.push(started);
  return started;
}

afterEach(() => {
  servers.splice(0).forEach((fake) => fake.stop());
  vi.restoreAllMocks();
});

describe("callTool against the fake Skills Wiki (facts 5 and 6)", () => {
  it("initializes, echoes the session id and returns structuredContent", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_active_combo");
    expect(outcome).toMatchObject({ ok: true, value: { combo_slug: "demo-combo", combo: { slug: "demo-combo" } } });
  });

  it("passes tool arguments and returns the folder form of get_skill_resource", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_skill_resource", { pack: "demo", skill_name: "install", path: "" });
    expect(outcome).toMatchObject({ ok: true, value: { resources: [{ path: "notes.md", kind: "reference" }, { path: "recipe.json", kind: "reference" }] } });
  });

  it("reports an isError answer as a tool error, not a crash", async () => {
    const fake = await server();
    const outcome = await callTool({ url: fake.url, key: fake.key }, "get_skill_resource", { pack: "demo", skill_name: "install", path: "missing.json" });
    expect(outcome).toEqual({ ok: false, error: "Resource not found: demo/install/missing.json" });
  });

  it("reports a JSON-RPC error as a tool error", async () => {
    const fake = await server();
    await expect(callTool({ url: fake.url, key: fake.key }, "no_such_tool")).resolves.toEqual({ ok: false, error: "Unknown tool: no_such_tool" });
  });

  it("turns a 401 into the secret hint (Review Focus 3)", async () => {
    const fake = await server();
    await expect(callTool({ url: fake.url, key: "wrong" }, "get_active_combo")).rejects.toThrow(KEY_REJECTED_HINT);
  });

  it("names the url when the server is unreachable", async () => {
    const fake = await server();
    fake.stop();
    await new Promise((tick) => setTimeout(tick, 50));
    await expect(callTool({ url: fake.url, key: fake.key }, "get_active_combo")).rejects.toThrow(`Cannot reach Skills Wiki at '${fake.url}'`);
  });
});

describe("callTool answer parsing (Review Focus 5)", () => {
  const target = { url: "https://wiki.test/mcp", key: "k" };
  const sse = (messages: unknown[]) => new Response(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });

  it("accepts application/json answers and falls back to JSON in content[0].text", async () => {
    const result = { content: [{ type: "text", text: JSON.stringify({ combo_slug: "from-text" }) }], isError: false };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 1, result: {} }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(json({ jsonrpc: "2.0", id: 2, result }));
    await expect(callTool(target, "get_active_combo")).resolves.toEqual({ ok: true, value: { combo_slug: "from-text" } });
  });

  it("picks the message with the matching id out of a multi-event stream", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sse([{ jsonrpc: "2.0", id: 1, result: {} }]))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(sse([{ jsonrpc: "2.0", method: "notifications/progress" }, { jsonrpc: "2.0", id: 2, result: { structuredContent: { x: 1 } } }]));
    await expect(callTool(target, "t")).resolves.toEqual({ ok: true, value: { x: 1 } });
  });

  it.each([
    ["non-JSON", () => new Response("<html>", { headers: { "content-type": "text/html" } }), /sent no answer to request 1/],
    ["a stream without the request id", () => sse([{ jsonrpc: "2.0", id: 9, result: {} }]), /sent no answer to request 1/],
    ["an HTTP 500", () => json({}, { status: 500 }), /answered HTTP 500/],
    ["a body over the cap", () => new Response("x".repeat(MCP_MAX_BYTES + 1), { headers: { "content-type": "application/json" } }), /larger than 1000000 bytes/],
  ])("turns %s into a failure with a reason", async (_name, make, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(make());
    await expect(callTool(target, "t")).rejects.toThrow(ActionFailure);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(make());
    await expect(callTool(target, "t")).rejects.toThrow(message);
  });

  it("names a timeout", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    await expect(callTool(target, "t")).rejects.toThrow("Cannot reach Skills Wiki at 'https://wiki.test/mcp' (timed out after 30000 ms)");
  });
});
