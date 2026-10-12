import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake model received. */
export interface ModelRequest {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

export interface FakeModel {
  readonly url: string;
  /** Points connector URLs at this server (loopback only, with the file keychain the tests use, D65). */
  readonly env: Readonly<Record<string, string>>;
  readonly key: string;
  /** The texts the model answers, in order; the last one repeats. "__refusal" answers with stop_reason refusal. */
  readonly answer: (...texts: string[]) => void;
  readonly requests: () => readonly ModelRequest[];
  readonly stop: () => Promise<void>;
}

/**
 * A loopback stand-in for two model APIs, shaped like their documentation: Anthropic Messages (`POST /v1/messages`,
 * `x-api-key`, `anthropic-version`) and OpenAI-compatible chat completions (`POST /v1/chat/completions`, Bearer).
 * No real model is ever called by the offline tests (D48).
 */
export async function startFakeModel(key = "model-test-key"): Promise<FakeModel> {
  const requests: ModelRequest[] = [];
  let answers = ['{"label":"now","confidence":0.9}'];
  let served = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ path: req.url ?? "", headers: req.headers, body });
      const send = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const text = answers[Math.min(served, answers.length - 1)] ?? "";
      if (req.url === "/v1/messages") {
        if (req.headers["x-api-key"] !== key || req.headers["anthropic-version"] !== "2023-06-01") return send(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        served += 1;
        if (text === "__refusal") return send(200, { type: "message", role: "assistant", content: [], stop_reason: "refusal" });
        return send(200, { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } });
      }
      if (req.url === "/v1/chat/completions") {
        if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { message: "Incorrect API key provided" } });
        served += 1;
        return send(200, { choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      }
      return send(404, { error: { message: `no route ${req.url}` } });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, key, env: { INSTALLER_CONNECTOR_SERVER: url, INSTALLER_KEYCHAIN: "file" },
    answer: (...texts) => {
      answers = texts;
      served = 0;
    },
    requests: () => requests,
    stop: () => new Promise((done) => server.close(() => done())),
  };
}
