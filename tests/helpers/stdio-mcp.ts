import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

export interface StdioMcp {
  /** Sends a request and resolves with the answer that carries its id; rejects if the server exits first. */
  readonly request: (method: string, params?: unknown, id?: string | number) => Promise<Record<string, unknown>>;
  readonly notify: (method: string, params?: unknown) => void;
  /** Every line the server printed on stdout so far. */
  readonly lines: string[];
  /** Closes stdin and resolves with the exit code. */
  readonly close: () => Promise<number | null>;
}

interface Waiting {
  readonly done: (message: Record<string, unknown>) => void;
  readonly fail: (error: Error) => void;
}

/** Spawns `taskpilot --home <home> mcp-serve` the way an agent's MCP client does. */
export function startStdioMcp(home: string): StdioMcp {
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "--home", home, "mcp-serve"], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.on("error", () => undefined);
  const lines: string[] = [];
  const waiting = new Map<string | number, Waiting>();
  const exited = new Promise<number | null>((done) => child.once("exit", done));
  void exited.then((code) => waiting.forEach((entry) => entry.fail(new Error(`installer mcp-serve exited with ${code} before answering`))));
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const message = JSON.parse(line) as Record<string, unknown>;
    waiting.get(message.id as string | number)?.done(message);
  });
  let next = 1;
  const write = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  return {
    request: (method, params, id = next++) =>
      new Promise((done, fail) => {
        waiting.set(id, { done, fail });
        write({ id, method, ...(params === undefined ? {} : { params }) });
      }),
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    lines,
    close: () => {
      child.stdin.end();
      return exited;
    },
  };
}
