import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface FakeMcp {
  readonly url: string;
  readonly key: string;
  readonly stop: () => void;
}

/** Starts tests/fakes/fake-mcp-server.mjs on a free port; resolves once it printed its url. */
export function startFakeMcp(env: Record<string, string> = {}): Promise<FakeMcp> {
  const child = spawn(process.execPath, [resolve("tests/fakes/fake-mcp-server.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, FAKE_MCP_DIR: resolve("tests/fixtures/skillswiki"), ...env },
  });
  return new Promise((done, fail) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const { url } = JSON.parse(buffer.slice(0, newline)) as { url: string };
      done({ url, key: env.FAKE_MCP_KEY ?? "test-key", stop: () => void child.kill("SIGKILL") });
    });
    child.once("exit", (code) => fail(new Error(`fake MCP server exited with ${code}`)));
    child.once("error", fail);
  });
}
