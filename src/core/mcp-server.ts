import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ToolRefusal } from "./approvals.js";
import { AuditCorruptError } from "./audit.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { StateCorruptError } from "./state.js";

/**
 * The local MCP server (D56): newline-delimited JSON-RPC 2.0 on stdin/stdout, hand-rolled, tools only.
 * Verified against Claude Code 2.1.294: it first sends `server/discover` (answered "method not found",
 * which it accepts), then `initialize` asking 2025-11-25, and accepts 2025-06-18 in the answer.
 */
export const SERVER_INFO = { name: "installer", version: "0.1.0" };
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const SERVER_INSTRUCTIONS =
  "Tools at level L2 or L3 refuse to run until a person approves that exact call: call approvals.request with the tool, its arguments and why, " +
  "ask the person to approve it in their own terminal, then call approvals.get and repeat the call with the same arguments plus approval_token. " +
  "Never ask the person for a token and never try to approve anything yourself.";
const RPC = { PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 } as const;

export interface ToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ServerHandlers {
  readonly list: () => readonly ToolDescription[];
  readonly call: (name: string, args: unknown) => Promise<Readonly<Record<string, unknown>>>;
}

type Id = string | number | null;
type Message = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Message => typeof value === "object" && value !== null && !Array.isArray(value);

const answer = (id: Id, result: unknown): Message => ({ jsonrpc: "2.0", id, result });
const failure = (id: Id, code: number, message: string): Message => ({ jsonrpc: "2.0", id, error: { code, message } });

/** Errors the agent or a person can act on are tool results the model reads; anything else is an internal error. */
const ACTIONABLE = [InputError, ToolRefusal, ActionFailure, StateCorruptError, AuditCorruptError];

function toolError(error: unknown): Message {
  const message = error instanceof Error ? error.message : String(error);
  const text = ACTIONABLE.some((kind) => error instanceof kind) ? message : `Internal error: ${message}`;
  return { content: [{ type: "text", text }], isError: true };
}

function negotiate(params: unknown): string {
  const asked = isRecord(params) ? params.protocolVersion : undefined;
  return (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? (asked as string) : PROTOCOL_VERSIONS[0];
}

async function callTool(handlers: ServerHandlers, id: Id, params: unknown): Promise<Message> {
  const name = isRecord(params) ? params.name : undefined;
  if (typeof name !== "string") return failure(id, RPC.INVALID_PARAMS, "tools/call needs params.name");
  if (!handlers.list().some((tool) => tool.name === name)) return failure(id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`);
  try {
    const value = await handlers.call(name, (isRecord(params) ? params.arguments : undefined) ?? {});
    return answer(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
  } catch (error) {
    return answer(id, toolError(error));
  }
}

async function dispatch(handlers: ServerHandlers, id: Id, method: string, params: unknown): Promise<Message> {
  if (method === "initialize") {
    return answer(id, { protocolVersion: negotiate(params), capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
  }
  if (method === "ping") return answer(id, {});
  if (method === "tools/list") return answer(id, { tools: handlers.list() });
  if (method === "tools/call") return callTool(handlers, id, params);
  return failure(id, RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

/** One line in, at most one line out. Notifications and the client's own responses get no answer. */
export async function handleLine(handlers: ServerHandlers, line: string): Promise<Message | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, RPC.PARSE_ERROR, "Parse error");
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0") return failure(null, RPC.INVALID_REQUEST, "Expected one JSON-RPC 2.0 message per line");
  const { id, method } = message;
  if (id === undefined || typeof method !== "string") return null;
  if (typeof id !== "string" && typeof id !== "number") return failure(null, RPC.INVALID_REQUEST, "The id must be a string or a number");
  return dispatch(handlers, id, method, message.params);
}

/** Serves until the client closes stdin; requests are handled one at a time, in order. */
export function serveStdio(handlers: ServerHandlers, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    queue = queue.then(async () => {
      const reply = await handleLine(handlers, line);
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return new Promise((done) => {
    lines.once("close", () => void queue.then(done));
  });
}
