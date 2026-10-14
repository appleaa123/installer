import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { InputError } from "./inputs.js";

/** The page closes itself after ten minutes with nothing entered (D47). */
export const SECRET_PAGE_TTL_MS = 600_000;
/** Names the command that opens the browser; `none` opens nothing (tests, servers). */
export const BROWSER_ENV = "INSTALLER_BROWSER";
const MAX_BODY_BYTES = 65_536;
const HOST = "127.0.0.1";

export interface SecretPageOptions {
  readonly id: string;
  readonly store: (value: string) => Promise<void>;
  readonly ttlMs?: number;
}

export interface SecretPage {
  readonly url: string;
  /** Resolves once a value was stored, or when the page expired unused. */
  readonly done: Promise<"stored" | "expired">;
  readonly close: () => void;
}

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function formPage(id: string, action: string, error?: string): string {
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: enter the ${escapeHtml(id)} key</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}input{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}button{margin-top:1rem;font-size:1rem;padding:.5rem 1.5rem}.error{color:#b00020}</style></head>
<body><h1>Enter the <code>${escapeHtml(id)}</code> key</h1>
<p>This page is served by the installer on this computer only. The key goes into your keychain; the agent never sees it.</p>${notice}
<form method="post" action="${action}"><input type="password" name="value" autocomplete="off" autofocus required><button type="submit">Save</button></form>
</body></html>`;
}

export const DONE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: done</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto"><h1>Done, you can close this tab.</h1></body></html>`;

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(body);
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        fail(new InputError("The submitted form is too large"));
        req.destroy();
      }
    });
    req.on("end", () => done(body));
    req.on("error", fail);
  });
}

interface PageState {
  readonly path: string;
  readonly origin: string;
  finished: boolean;
}

/** GET shows the form; POST (same origin only) stores one value and ends the page (D47). */
async function handle(req: IncomingMessage, res: ServerResponse, page: PageState, options: SecretPageOptions, finish: () => void): Promise<void> {
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden");
  if (req.url !== page.path) return send(res, 404, "Not found");
  if (page.finished) return send(res, 410, DONE_PAGE);
  if (req.method === "GET") return send(res, 200, formPage(options.id, page.path));
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden");
  const value = new URLSearchParams(await readBody(req)).get("value") ?? "";
  try {
    await options.store(value);
  } catch (error) {
    const status = error instanceof InputError ? 400 : 500;
    return send(res, status, formPage(options.id, page.path, (error as Error).message));
  }
  page.finished = true;
  send(res, 200, DONE_PAGE);
  finish();
}

export function listen(server: Server): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, HOST, () => done((server.address() as AddressInfo).port));
  });
}

export async function startSecretPage(options: SecretPageOptions): Promise<SecretPage> {
  const path = `/s/${randomBytes(32).toString("hex")}`;
  let settle: (how: "stored" | "expired") => void = () => undefined;
  const done = new Promise<"stored" | "expired">((resolve) => {
    settle = resolve;
  });
  const server = createServer();
  const close = (how: "stored" | "expired"): void => {
    server.close();
    server.closeAllConnections();
    settle(how);
  };
  const port = await listen(server);
  const page: PageState = { path, origin: `http://${HOST}:${port}`, finished: false };
  server.on("request", (req, res) => {
    handle(req, res, page, options, () => close("stored")).catch((error: Error) => send(res, 400, formPage(options.id, path, error.message)));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? SECRET_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}

/** Starts `taskfollow secret-serve <id>` detached; the child reports its url over IPC and lives on after this process exits. */
export function launchSecretPage(id: string): Promise<{ url: string; pid: number }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [process.argv[1] ?? "", "secret-serve", id], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.once("message", (message) => {
      const { url } = message as { url?: unknown };
      if (typeof url !== "string" || !child.pid) return fail(new Error("The secret page did not report its url"));
      child.unref();
      done({ url, pid: child.pid });
    });
    child.once("exit", (code) => fail(new Error(`The secret page could not start (exit ${code})`)));
    child.once("error", fail);
  });
}

type Env = Readonly<Record<string, string | undefined>>;

/** On a machine without a browser, the person tunnels the port from their laptop (D47 headless host). */
export function headlessHint(url: string, env: Env = process.env): string | undefined {
  const headless = Boolean(env.SSH_CONNECTION) || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY);
  if (!headless) return undefined;
  const { port } = new URL(url);
  return `This machine has no browser: from your laptop run 'ssh -L ${port}:127.0.0.1:${port} <user>@<this host>', then open ${url} there`;
}

/** Best effort: a missing opener is not an error, the url is printed anyway. */
export function openBrowser(url: string, env: Env = process.env): boolean {
  const fallback = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : "none";
  const opener = env[BROWSER_ENV] || fallback;
  if (opener === "none") return false;
  spawn(opener, [url], { detached: true, stdio: "ignore" })
    .on("error", () => undefined)
    .unref();
  return true;
}
