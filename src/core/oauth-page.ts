import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ConnectorDef } from "./connectors.js";
import { authorizeUrl, exchangeCode, pkcePair, type OAuthClient } from "./google-auth.js";
import { InputError } from "./inputs.js";
import { requireSecretValue } from "./keychain.js";
import { DONE_PAGE, SECRET_PAGE_TTL_MS, escapeHtml, listen, readBody, type SecretPage } from "./secret-page.js";

/**
 * `installer secret <id>` for an OAuth connector (D66): the same detached loopback page as D47, in two halves.
 * 1. The form on the one-time path takes the person's own OAuth client id and secret, then sends the browser
 *    to Google's consent page (PKCE, offline access, a random `state`).
 * 2. Google sends the browser back to this page's root with `?code=…&state=…`; the page exchanges the code
 *    and writes {client_id, client_secret, refresh_token} to the keychain. The agent never sees any of it.
 */
export interface OAuthPageOptions {
  readonly def: ConnectorDef;
  readonly store: (value: string) => Promise<void>;
  readonly ttlMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface Pending {
  readonly client: OAuthClient;
  readonly verifier: string;
  readonly state: string;
}

interface PageState {
  readonly path: string;
  readonly origin: string;
  pending: Pending | null;
  finished: boolean;
}

const HOST = "127.0.0.1";

function send(res: ServerResponse, status: number, body: string, def: ConnectorDef): void {
  const consent = new URL(def.auth.authorize_url).origin;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${consent}` });
  res.end(body);
}

function formPage(def: ConnectorDef, action: string, error?: string): string {
  const notice = error ? `<p class="error">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: sign in to ${escapeHtml(def.name)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem}input{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box;margin-bottom:1rem}button{font-size:1rem;padding:.5rem 1.5rem}.error{color:#b00020}</style></head>
<body><h1>Sign in to ${escapeHtml(def.name)}</h1>
<p>This page is served by the installer on this computer only. Enter the OAuth client of the <b>Desktop app</b> you created in your own Google Cloud project; then Google asks you to allow access to your spreadsheets. Everything goes into your keychain; the agent never sees it.</p>${notice}
<form method="post" action="${action}"><label>Client ID<input name="client_id" autocomplete="off" required></label><label>Client secret<input type="password" name="client_secret" autocomplete="off" required></label><button type="submit">Continue to Google</button></form>
</body></html>`;
}

function messagePage(text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>installer: sign-in</title></head><body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto"><h1>${escapeHtml(text)}</h1></body></html>`;
}

/** POST of the form: keep the client in memory and send the browser to Google's consent page. */
async function startConsent(req: IncomingMessage, res: ServerResponse, page: PageState, def: ConnectorDef): Promise<void> {
  const form = new URLSearchParams(await readBody(req));
  let client: OAuthClient;
  try {
    client = { client_id: requireSecretValue(form.get("client_id") ?? ""), client_secret: requireSecretValue(form.get("client_secret") ?? "") };
  } catch (error) {
    return send(res, 400, formPage(def, page.path, (error as Error).message), def);
  }
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(32).toString("hex");
  page.pending = { client, verifier, state };
  res.writeHead(303, { location: authorizeUrl(def.auth, client.client_id, `${page.origin}/`, state, challenge), "cache-control": "no-store" });
  res.end();
}

/** GET /?code=…&state=… from Google: exchange once, store, finish. */
async function finishConsent(query: URLSearchParams, res: ServerResponse, page: PageState, options: OAuthPageOptions): Promise<boolean> {
  const { def } = options;
  const pending = page.pending;
  if (!pending || query.get("state") !== pending.state) {
    send(res, 400, messagePage("This sign-in link is stale: start again from the page the installer opened."), def);
    return false;
  }
  const denied = query.get("error");
  const code = query.get("code");
  if (denied || !code) {
    send(res, 400, formPage(def, page.path, `Google did not grant access (${denied ?? "no code"}). Try again.`), def);
    return false;
  }
  try {
    const refreshToken = await exchangeCode(def.auth, pending.client, { code, redirectUri: `${page.origin}/`, verifier: pending.verifier }, options.env);
    await options.store(JSON.stringify({ ...pending.client, refresh_token: refreshToken }));
  } catch (error) {
    send(res, 400, formPage(def, page.path, (error as Error).message), def);
    return false;
  }
  page.finished = true;
  send(res, 200, DONE_PAGE, def);
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse, page: PageState, options: OAuthPageOptions, finish: () => void): Promise<void> {
  const { def } = options;
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden", def);
  const url = new URL(req.url ?? "/", page.origin);
  const known = url.pathname === page.path || (url.pathname === "/" && url.search !== "");
  if (!known) return send(res, 404, "Not found", def);
  if (page.finished) return send(res, 410, DONE_PAGE, def);
  if (url.pathname === "/") {
    if (req.method !== "GET") return send(res, 405, "Method not allowed", def);
    if (await finishConsent(url.searchParams, res, page, options)) finish();
    return;
  }
  if (req.method === "GET") return send(res, 200, formPage(def, page.path), def);
  if (req.method !== "POST") return send(res, 405, "Method not allowed", def);
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden", def);
  return startConsent(req, res, page, def);
}

export async function startOAuthPage(options: OAuthPageOptions): Promise<SecretPage> {
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
  const page: PageState = { path, origin: `http://${HOST}:${port}`, pending: null, finished: false };
  server.on("request", (req, res) => {
    handle(req, res, page, options, () => close("stored")).catch((error: Error) => send(res, 400, formPage(options.def, path, error instanceof InputError ? error.message : "The sign-in failed"), options.def));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? SECRET_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}
