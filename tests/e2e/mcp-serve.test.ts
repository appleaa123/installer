import { describe, expect, it } from "vitest";
import { approveItem } from "../../src/core/approvals.js";
import { verifyAudit } from "../../src/core/audit.js";
import { runCli } from "../helpers/cli.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { startStdioMcp, type StdioMcp } from "../helpers/stdio-mcp.js";
import { makeTempHome } from "../helpers/temp-home.js";

type CallResult = { result: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean } };

/** The handshake Claude Code 2.1.294 was seen to make (D56 facts). */
async function connect(home: string): Promise<StdioMcp> {
  const server = startStdioMcp(home);
  await server.request("server/discover", {}, "server-discover-probe-1");
  await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 0);
  server.notify("notifications/initialized");
  return server;
}

const call = async (server: StdioMcp, name: string, args: Record<string, unknown>) => (await server.request("tools/call", { name, arguments: args })) as unknown as CallResult;

describe("installer mcp-serve (D56)", () => {
  it("speaks the handshake, lists the tools and prints nothing but JSON-RPC lines", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const server = await connect(home);
    const listed = (await server.request("tools/list")) as { result: { tools: { name: string }[] } };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "approvals.request", "approvals.list", "approvals.get", "actions.reason", "memo.list", "memo.add", "memo.edit", "memo.delete",
      "records.find", "records.get", "records.create", "records.update", "records.preview_import", "records.import",
      "channel.list", "channel.inbox", "channel.attachment", "channel.notify", "channel.send",
    ]);
    expect(await server.close()).toBe(0);
    expect(server.lines).toHaveLength(3);
    expect(server.lines.every((line) => (JSON.parse(line) as { jsonrpc: string }).jsonrpc === "2.0")).toBe(true);
    expect(JSON.parse(server.lines[1] ?? "{}")).toMatchObject({ id: 0, result: { protocolVersion: "2025-06-18", serverInfo: { name: "installer" } } });
  });

  it("enforces approvals exactly like taskfollow tool: refuse, request, a person approves, run once", async () => {
    const home = await makeTempHome();
    runCli(["start", "--solution", FIXTURE_REF], { home });
    const server = await connect(home);
    expect((await call(server, "memo.add", { text: "Draft" })).result.structuredContent).toMatchObject({ id: 1, text: "Draft" });
    const refused = await call(server, "memo.delete", { id: 1 });
    expect(refused.result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("memo.delete is L3 (floor: irreversible)") }] });
    const item = (await call(server, "approvals.request", { tool: "memo.delete", args: { id: 1 }, why: "Not needed any more." })).result.structuredContent;
    expect(item).toMatchObject({ id: 1, level: "L3", required_role: "decision_maker" });
    await approveItem(home, 1, { name: "Owner", role: "decision_maker" }, new Date().toISOString());
    const token = (await call(server, "approvals.get", { id: 1 })).result.structuredContent?.approval_token;
    expect((await call(server, "memo.delete", { id: 1, approval_token: token })).result.structuredContent).toEqual({ deleted: true, id: 1 });
    expect((await call(server, "memo.delete", { id: 1, approval_token: token })).result).toMatchObject({ isError: true });
    expect(await server.close()).toBe(0);
    await expect(verifyAudit(home)).resolves.toMatchObject({ ok: true });
  });

  it("starts without an install (so the agent can connect early) and says what is missing on a call", async () => {
    const server = await connect(await makeTempHome());
    expect((await call(server, "memo.list", {})).result).toEqual({ content: [{ text: "No install found in this home; run 'taskfollow start --solution <ref>' first", type: "text" }], isError: true });
    expect(await server.close()).toBe(0);
  });
});
