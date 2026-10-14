import { ActionFailure } from "./failure.js";

/** Hand-rolled MCP Streamable HTTP client: initialize → notifications/initialized → tools/call (D55). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_TIMEOUT_MS = 30_000;
export const MCP_MAX_BYTES = 1_000_000;
export const KEY_REJECTED_HINT = "Skills Wiki key rejected: run `taskfollow secret skillswiki`";
const CLIENT_INFO = { name: "installer", version: "0.1.0" };

export interface McpTarget {
  readonly url: string;
  readonly key: string;
}

export type ToolOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

interface RpcMessage {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

interface Reply {
  readonly text: string;
  readonly contentType: string;
  readonly sessionId: string | null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function describe(error: unknown): string {
  const { name, message } = error as { name?: string; message?: string };
  return name === "TimeoutError" ? `timed out after ${MCP_TIMEOUT_MS} ms` : (message ?? String(error));
}

const tooLarge = (): ActionFailure => new ActionFailure(`Skills Wiki answer is larger than ${MCP_MAX_BYTES} bytes`);

/** Reads at most MCP_MAX_BYTES; a stalled or endless answer is a failure, never a crash or a memory blow-up. */
async function readCapped(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length") ?? "0") > MCP_MAX_BYTES) throw tooLarge();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      size += next.value.byteLength;
      if (size > MCP_MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ActionFailure) throw error;
    throw new ActionFailure(`Cannot read the Skills Wiki answer (${describe(error)})`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One POST; the session id of the initialize answer is echoed on every later request. */
async function post(target: McpTarget, body: unknown, sessionId?: string | null): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${target.key}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  };
  let response: Response;
  try {
    response = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(MCP_TIMEOUT_MS) });
  } catch (error) {
    throw new ActionFailure(`Cannot reach Skills Wiki at '${target.url}' (${describe(error)})`);
  }
  if (response.status === 401 || response.status === 403) throw new ActionFailure(KEY_REJECTED_HINT);
  if (!response.ok) throw new ActionFailure(`Skills Wiki answered HTTP ${response.status}`);
  const text = await readCapped(response);
  return { text, contentType: response.headers.get("content-type") ?? "", sessionId: response.headers.get("mcp-session-id") };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** SSE: every event's `data:` lines joined are one JSON-RPC message; JSON: one message or a batch. */
function messagesOf(reply: Reply): unknown[] {
  if (!reply.contentType.includes("text/event-stream")) {
    const parsed = parseJson(reply.text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return reply.text.split(/\r?\n\r?\n/).map((event) =>
    parseJson(
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n"),
    ),
  );
}

function messageFor(reply: Reply, id: number): RpcMessage {
  const found = messagesOf(reply).find((message) => isRecord(message) && message.id === id);
  if (!found) throw new ActionFailure(`Skills Wiki sent no answer to request ${id} (${reply.contentType || "no content type"})`);
  return found as RpcMessage;
}

const errorText = (message: RpcMessage): string => (typeof message.error?.message === "string" ? message.error.message : "unknown error");

/** Prefers structuredContent; falls back to JSON in content[0].text (observed on the hosted Skills Wiki). */
function outcomeOf(result: unknown): ToolOutcome {
  if (!isRecord(result)) return { ok: false, error: "tool returned no result" };
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const first = content[0];
  const text = isRecord(first) && typeof first.text === "string" ? first.text : "";
  if (result.isError === true) return { ok: false, error: text || "tool reported an error" };
  if (isRecord(result.structuredContent)) return { ok: true, value: result.structuredContent };
  const parsed = parseJson(text);
  return parsed === undefined ? { ok: false, error: "tool returned no JSON content" } : { ok: true, value: parsed };
}

const rpc = (id: number, method: string, params: unknown): unknown => ({ jsonrpc: "2.0", id, method, params });

export async function callTool(target: McpTarget, name: string, args: Readonly<Record<string, unknown>> = {}): Promise<ToolOutcome> {
  const init = await post(target, rpc(1, "initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }));
  const opened = messageFor(init, 1);
  if (opened.error) throw new ActionFailure(`Skills Wiki refused the connection: ${errorText(opened)}`);
  await post(target, { jsonrpc: "2.0", method: "notifications/initialized" }, init.sessionId);
  const called = messageFor(await post(target, rpc(2, "tools/call", { name, arguments: args }), init.sessionId), 2);
  if (called.error) return { ok: false, error: errorText(called) };
  return outcomeOf(called.result);
}
