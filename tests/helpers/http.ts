import { request as httpRequest } from "node:http";

export interface HttpReply {
  readonly status: number;
  readonly text: string;
}

/** A raw request on a fresh connection whose Host and Origin headers are exactly what the test says (fetch would rewrite Host). */
export function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpReply> {
  const target = new URL(url);
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "GET", headers: options.headers ?? {}, setHost: options.headers?.Host === undefined, agent: false },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", fail);
    req.end(options.body);
  });
}

export const formHeaders = (origin: string): Record<string, string> => ({ Origin: origin, "Content-Type": "application/x-www-form-urlencoded" });

/** Polls until the process is gone; fails after the timeout. */
export async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > until) throw new Error(`Process ${pid} is still running`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}
