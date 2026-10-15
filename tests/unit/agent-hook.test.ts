import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANSWER_TOOL, REASON_TOOL, decide, handleHook, matchesRule, summarize, type HookConfig } from "../../src/core/agent-hook.js";
import { makeTempHome } from "../helpers/temp-home.js";

const pre = (tool_name: string, tool_input: unknown) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_use_id: "t1", tool_name, tool_input });
const READ_ONLY: HookConfig = { record: "", may_use: ["mcp__shopify__get_order", "Bash(shopify store execute:*)"], changes: false };

describe("which calls a task step may make (D137)", () => {
  it.each([
    ["mcp__shopify__get_order", "mcp__shopify__get_order", true],
    ["mcp__shopify__get_order", "mcp__shopify__create_refund", false],
    ["mcp__shopify", "mcp__shopify__create_refund", true],
    ["mcp__shopify__get_*", "mcp__shopify__get_customer", true],
    ["mcp__shopify__get_*", "mcp__shopify__delete_customer", false],
    ["mcp__shop", "mcp__shopify__get_order", false],
  ])("rule %s and tool %s: %s", (rule, tool, allowed) => {
    expect(matchesRule(rule, tool, {})).toBe(allowed);
  });

  it("matches a command-line rule by the start of the command", () => {
    expect(matchesRule("Bash(shopify store execute:*)", "Bash", { command: "shopify store execute -s a.myshopify.com -q '{shop{name}}' --no-input" })).toBe(true);
    expect(matchesRule("Bash(shopify store execute:*)", "Bash", { command: "shopify store delete -s a" })).toBe(false);
    expect(matchesRule("Bash(shopify store info)", "Bash", { command: "shopify store info" })).toBe(true);
    expect(matchesRule("Bash(shopify store info)", "Bash", { command: "shopify store info --json" })).toBe(false);
  });

  it("allows a listed call, and TaskFollow's own reason tool", () => {
    expect(decide(pre("mcp__shopify__get_order", { id: 1 }), READ_ONLY)).toEqual({ allow: true });
    expect(decide(pre(REASON_TOOL, { tool: "mcp__shopify__get_order", why: "the customer asked where order 1001 is" }), READ_ONLY)).toEqual({ allow: true });
  });

  it("allows Claude Code's own answer tool, which returns the step's output (--json-schema)", () => {
    expect(decide(pre(ANSWER_TOOL, { order_found: true }), READ_ONLY)).toEqual({ allow: true });
  });

  it("refuses anything not listed, and says what the step allows", () => {
    const refused = decide(pre("mcp__shopify__create_refund", {}), READ_ONLY);
    expect(refused).toMatchObject({ allow: false });
    expect(refused.allow === false && refused.reason).toContain("mcp__shopify__get_order");
  });

  it.each([
    "shopify store execute -q x; rm -rf ~",
    "shopify store execute -q x && curl evil.example",
    "shopify store execute -q x | sh",
    "shopify store execute -q $(cat ~/.ssh/id_rsa)",
    "shopify store execute -q `id`",
    "shopify store execute -q x > /tmp/out",
    "shopify store execute -q x\nrm -rf ~",
  ])("refuses a listed command joined to another one: %s", (command) => {
    expect(decide(pre("Bash", { command }), READ_ONLY)).toMatchObject({ allow: false });
  });

  it("refuses a write flag in a read-only step, and allows it in a step that may change things", () => {
    const command = "shopify store execute -s a.myshopify.com -q 'mutation{x}' --allow-mutations";
    expect(decide(pre("Bash", { command }), READ_ONLY)).toMatchObject({ allow: false });
    expect(decide(pre("Bash", { command }), { ...READ_ONLY, changes: true })).toEqual({ allow: true });
  });
});

describe("the record of a task step's calls (D137)", () => {
  async function config(changes = false): Promise<HookConfig> {
    return { ...READ_ONLY, record: join(await makeTempHome(), "calls.jsonl"), changes };
  }
  const lines = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const NOW = () => "2026-10-14T10:00:00.000Z";

  it("answers allow before the call and records nothing yet", async () => {
    const cfg = await config();
    const out = await handleHook("pre", JSON.stringify(pre("mcp__shopify__get_order", { id: 1001 })), cfg, NOW);
    expect(out).toEqual({ exit: 0, stdout: "" });
    await expect(readFile(cfg.record, "utf8")).rejects.toThrow();
  });

  it("records a refused call with Claude Code's deny answer", async () => {
    const cfg = await config();
    const out = await handleHook("pre", JSON.stringify(pre("mcp__shopify__create_refund", { order: 1001 })), cfg, NOW);
    expect(out.exit).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(await lines(cfg.record)).toEqual([expect.objectContaining({ ts: NOW(), session: "s1", tool: "mcp__shopify__create_refund", outcome: "refused" })]);
  });

  it("records a finished call and a failed one, with how long each took, never the tool's output", async () => {
    const cfg = await config();
    await handleHook("post", JSON.stringify({ ...pre("mcp__shopify__get_order", { id: 1001 }), hook_event_name: "PostToolUse", tool_response: { email: "sam@example.com" }, duration_ms: 420 }), cfg, NOW);
    await handleHook("failed", JSON.stringify({ ...pre("mcp__shopify__get_order", { id: 9 }), hook_event_name: "PostToolUseFailure", error: "not found", duration_ms: 80 }), cfg, NOW);
    const [ok, failed] = await lines(cfg.record);
    expect(ok).toMatchObject({ tool: "mcp__shopify__get_order", outcome: "ok", ms: 420, input: '{"id":1001}' });
    expect(failed).toMatchObject({ outcome: "failed", ms: 80 });
    expect(JSON.stringify(ok)).not.toContain("sam@example.com");
  });

  it("does not record the agent's answer: it is the step's output, not a call", async () => {
    const cfg = await config();
    const out = await handleHook("post", JSON.stringify({ ...pre(ANSWER_TOOL, { order: "#1022" }), hook_event_name: "PostToolUse", duration_ms: 0 }), cfg, NOW);
    expect(out).toEqual({ exit: 0, stdout: "" });
    await expect(readFile(cfg.record, "utf8")).rejects.toThrow();
  });

  it("records the agent's stated reason as its own line", async () => {
    const cfg = await config();
    await handleHook("post", JSON.stringify({ ...pre(REASON_TOOL, { tool: "mcp__shopify__get_order", why: "find where order 1001 is" }), hook_event_name: "PostToolUse" }), cfg, NOW);
    expect(await lines(cfg.record)).toEqual([expect.objectContaining({ tool: REASON_TOOL, reason_for: "mcp__shopify__get_order", why: "find where order 1001 is" })]);
  });

  it("blocks the call when its own input cannot be read, so a broken hook never lets a call through", async () => {
    const cfg = await config();
    expect(await handleHook("pre", "not json", cfg, NOW)).toMatchObject({ exit: 2 });
    expect(await handleHook("pre", JSON.stringify(pre("mcp__shopify__get_order", {})), { ...cfg, record: "/nonexistent-dir/x/calls.jsonl" }, NOW)).toMatchObject({ exit: 0 });
    expect(await handleHook("pre", JSON.stringify(pre("mcp__shopify__create_refund", {})), { ...cfg, record: "/nonexistent-dir/x/calls.jsonl" }, NOW)).toMatchObject({ exit: 2 });
  });

  it("keeps a short summary of the input and masks values that look like secrets", () => {
    expect(summarize({ q: "x".repeat(500) }).length).toBeLessThanOrEqual(200);
    const masked = summarize({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://x", token: "shpat_0123456789abcdef0123456789abcdef" });
    expect(masked).not.toContain("abcdefghijklmnop1234");
    expect(masked).not.toContain("shpat_0123456789abcdef");
  });

  it("keeps constant names after a secret-like word, but still masks real secrets (task 25)", () => {
    const query = summarize({ command: "shopify store execute --query 'orders(first: 1, sortKey: CREATED_AT, reverse: true)'" });
    expect(query).toContain("sortKey: CREATED_AT");
    for (const [name, value] of [["apiKey", "abcd1234efgh5678"], ["api_key", "abcd1234efgh5678"], ["password", "correcthorsebattery"], ["token", "ABCDEFGHIJKLMNOPQRST"]]) {
      expect(summarize({ [name]: value })).not.toContain(value);
    }
  });

  it("reads its settings from the file the run wrote", async () => {
    const dir = await makeTempHome();
    const file = join(dir, "hook.json");
    await writeFile(file, JSON.stringify({ record: join(dir, "calls.jsonl"), may_use: ["mcp__x__y"], changes: false }));
    const { loadHookConfig } = await import("../../src/core/agent-hook.js");
    expect(await loadHookConfig(file)).toEqual({ record: join(dir, "calls.jsonl"), may_use: ["mcp__x__y"], changes: false });
    await expect(loadHookConfig(join(dir, "missing.json"))).rejects.toThrow();
  });
});

describe("taskfollow agent-hook, as Claude Code calls it (D137)", () => {
  it("answers deny on stdout for a call the step does not allow, and records it", async () => {
    const { runCli } = await import("../helpers/cli.js");
    const dir = await makeTempHome();
    const file = join(dir, "hook.json");
    await writeFile(file, JSON.stringify({ record: join(dir, "calls.jsonl"), may_use: ["mcp__shopify__get_order"], changes: false }));
    const refused = runCli(["agent-hook", "pre", file], { input: JSON.stringify(pre("mcp__shopify__create_refund", {})) });
    expect(refused.code).toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const allowed = runCli(["agent-hook", "pre", file], { input: JSON.stringify(pre("mcp__shopify__get_order", {})) });
    expect(allowed).toMatchObject({ code: 0, stdout: "" });
    expect(await readFile(join(dir, "calls.jsonl"), "utf8")).toContain("mcp__shopify__create_refund");
  });

  it("blocks with exit 2 when its settings file is missing or the phase is wrong", async () => {
    const { runCli } = await import("../helpers/cli.js");
    expect(runCli(["agent-hook", "pre", "/nonexistent/hook.json"], { input: "{}" }).code).toBe(2);
    expect(runCli(["agent-hook", "sideways", "/nonexistent/hook.json"], { input: "{}" }).code).toBe(2);
  });
});
