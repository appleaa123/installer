import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { ActionFailure } from "./failure.js";
import { DONE_PAGE, LONG_PAGE_TTL_MS, escapeHtml, listen, readBody, type SecretPage } from "./secret-page.js";
import { parseDelivery, pullRelay, verifySignature, whatsappApi } from "./whatsapp.js";
import { deployRelay, newRelaySecrets, type RelaySecrets } from "./whatsapp-deploy.js";

/**
 * `taskfollow secret whatsapp` (D149): the same detached loopback page as the others, in three steps. (1) The person
 * pastes a Cloudflare API token; the page puts the relay into their own Cloudflare account and shows the callback
 * address and verify token to paste into Meta (the Cloudflare token is used for that and forgotten). (2) They paste
 * Meta's System User access token, the app secret and the phone number id; the page checks them with Meta. (3) They
 * send any WhatsApp message to the business number; the page waits for one that Meta really signed, forgets it, and
 * only then stores the tokens as `whatsapp` and the relay address and number as `whatsapp-settings`.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Step = "cloudflare" | "meta" | "check";

export interface WhatsAppPageOptions {
  readonly store: (id: string, value: string) => Promise<void>;
  /** The stored `whatsapp` item, if any: its relay secrets are kept so the address in Meta keeps working. */
  readonly existing: () => Promise<string | null>;
  readonly env?: Env;
  readonly ttlMs?: number;
  /** How long one "Check" waits for the test message. */
  readonly waitMs?: number;
}

interface PageState {
  readonly path: string;
  readonly origin: string;
  finished: boolean;
  step: Step;
  secrets?: RelaySecrets;
  relayUrl?: string;
  callbackUrl?: string;
  meta?: { readonly access_token: string; readonly app_secret: string; readonly phone_number_id: string; readonly display_number: string };
}

const HOST = "127.0.0.1";
const CHECK_EVERY_MS = 1000;
const DEFAULT_WAIT_MS = 20_000;
const CSS = "body{font-family:system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.5}label{display:block;margin-top:1rem}input{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}code.copy{display:block;padding:.6rem;background:#f3f3f3;word-break:break-all;margin:.3rem 0}button{margin-top:1.5rem;font-size:1rem;padding:.6rem 1.2rem}.error{color:#a40000;font-weight:600}.note{color:#555}li{margin-bottom:.6rem}";

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(body);
}
const layout = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TaskFollow: connect WhatsApp</title><style>${CSS}</style></head><body><h1>Connect WhatsApp</h1><p>This page is served by TaskFollow on this computer only. Nothing you type here goes to your AI assistant.</p>${body}</body></html>`;
const errorLine = (error?: string): string => (error ? `<p class="error">${escapeHtml(error)}</p>` : "");

function cloudflarePage(page: PageState, error?: string): string {
  return layout(`${errorLine(error)}
<p class="note">Customers' WhatsApp messages pass through Meta and through a small relay in your own free Cloudflare account, where each waits at most 72 hours until this computer collects it. Nothing goes through anyone else's account.</p>
<h2>Step 1 of 3: your relay</h2>
<ol>
<li>Sign in at <a href="https://dash.cloudflare.com/sign-up" target="_blank" rel="noopener">dash.cloudflare.com</a> (a free account is enough).</li>
<li>Open <b>My Profile</b>, then <b>API Tokens</b>, then <b>Create Token</b>, then <b>Create Custom Token</b>. Give it these permissions for your account: <b>Workers Scripts: Edit</b>, <b>D1: Edit</b>, <b>Account Settings: Read</b>. Create it and copy it.</li>
</ol>
<form method="post" action="${page.path}"><input type="hidden" name="step" value="cloudflare">
<label>Cloudflare API token<input type="password" name="cloudflare_token" autocomplete="off" required></label>
<button type="submit">Set up my relay</button><p class="note">This takes a few seconds. The token is used for this only and not kept.</p></form>`);
}

function metaPage(page: PageState, error?: string): string {
  return layout(`${errorLine(error)}
<h2>Step 2 of 3: your WhatsApp business number</h2>
<ol>
<li>In <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">Meta for Developers</a>, open your app (type Business) with the <b>WhatsApp</b> product added.</li>
<li>Under <b>WhatsApp</b>, then <b>Configuration</b>, then <b>Webhook</b>, press <b>Edit</b> and paste:<br>Callback URL <code class="copy">${escapeHtml(page.callbackUrl ?? "")}</code>Verify token <code class="copy">${escapeHtml(page.secrets?.verify_token ?? "")}</code>Press <b>Verify and save</b>, then subscribe to the <b>messages</b> field.</li>
<li>Copy the <b>Phone number ID</b> (under <b>API Setup</b>) and the <b>App secret</b> (under <b>App settings</b>, then <b>Basic</b>).</li>
<li>Make a lasting access token: in <b>Business settings</b>, <b>System users</b>, add a system user, give it your app and your WhatsApp account, and generate a token with <b>whatsapp_business_messaging</b> and <b>whatsapp_business_management</b>. The temporary token on the API Setup page stops working after a day.</li>
</ol>
<form method="post" action="${page.path}"><input type="hidden" name="step" value="meta">
<label>Access token (system user)<input type="password" name="access_token" autocomplete="off" required></label>
<label>App secret<input type="password" name="app_secret" autocomplete="off" required></label>
<label>Phone number ID<input type="text" name="phone_number_id" inputmode="numeric" autocomplete="off" required></label>
<button type="submit">Check with Meta</button></form>`);
}

function checkPage(page: PageState, error?: string): string {
  return layout(`${errorLine(error)}
<h2>Step 3 of 3: one real message</h2>
<p>From your own phone, send any WhatsApp message to <b>${escapeHtml(page.meta?.display_number ?? "")}</b>, then press Check. (While Meta's app is in development mode, add your own number to the test number's allowed list first.)</p>
<form method="post" action="${page.path}"><input type="hidden" name="step" value="check"><button type="submit">Check</button></form>`);
}

const CONNECTED_PAGE = layout("<h2>Connected</h2><p>WhatsApp is connected. Go back to the chat and tell your assistant. You can close this tab.</p>");
const plain = (message: string): string => message.replace(/: run 'taskfollow secret whatsapp' again/g, "; check it and paste it again");

async function relayStep(page: PageState, form: URLSearchParams, options: WhatsAppPageOptions): Promise<[number, string]> {
  const token = (form.get("cloudflare_token") ?? "").trim();
  if (token === "") return [400, cloudflarePage(page, "Paste the Cloudflare API token first.")];
  const existing = await options.existing();
  let kept: RelaySecrets | null = null;
  try {
    const raw = existing ? (JSON.parse(existing) as Record<string, unknown>) : {};
    if (typeof raw.verify_token === "string" && typeof raw.pull_token === "string" && typeof raw.path_key === "string") kept = { verify_token: raw.verify_token, pull_token: raw.pull_token, path_key: raw.path_key };
  } catch {
    kept = null;
  }
  const secrets = kept ?? newRelaySecrets();
  try {
    const deployed = await deployRelay(token, { secrets, keep: kept !== null }, options.env ?? process.env);
    Object.assign(page, { secrets, relayUrl: deployed.relay_url, callbackUrl: deployed.callback_url, step: "meta" as Step });
    return [200, metaPage(page)];
  } catch (error) {
    return [400, cloudflarePage(page, error instanceof ActionFailure ? error.message : "Cloudflare could not be reached. Check your internet connection and try again.")];
  }
}

async function metaStep(page: PageState, form: URLSearchParams, options: WhatsAppPageOptions): Promise<[number, string]> {
  const fields = { access_token: (form.get("access_token") ?? "").trim(), app_secret: (form.get("app_secret") ?? "").trim(), phone_number_id: (form.get("phone_number_id") ?? "").trim() };
  if (!/^\d{5,25}$/.test(fields.phone_number_id)) return [400, metaPage(page, "The Phone number ID is a long number from the API Setup page (not the phone number itself).")];
  if (!fields.access_token || !fields.app_secret) return [400, metaPage(page, "Paste the access token and the app secret.")];
  try {
    const info = await whatsappApi({ ...fields, pull_token: page.secrets?.pull_token ?? "" }, fields.phone_number_id, options.env ?? process.env).phoneInfo();
    page.meta = { ...fields, display_number: info.display_number };
    page.step = "check";
    return [200, checkPage(page)];
  } catch (error) {
    return [400, metaPage(page, plain(error instanceof ActionFailure ? error.message : "Meta could not be reached. Check your internet connection and try again."))];
  }
}

/** Waits for a delivery Meta really signed for this number; the relay then forgets everything up to it. */
async function proofArrived(page: PageState, options: WhatsAppPageOptions): Promise<boolean> {
  const env = options.env ?? process.env;
  const end = Date.now() + (options.waitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    const items = await pullRelay(page.relayUrl ?? "", page.secrets?.pull_token ?? "", 0, env);
    const proof = items.find((item) => {
      const bytes = Buffer.from(item.body_b64, "base64");
      if (!verifySignature(bytes, item.signature, page.meta?.app_secret ?? "")) return false;
      try {
        return parseDelivery(JSON.parse(bytes.toString("utf8")), page.meta?.phone_number_id ?? "").length > 0;
      } catch {
        return false;
      }
    });
    if (proof) {
      await pullRelay(page.relayUrl ?? "", page.secrets?.pull_token ?? "", proof.id, env);
      return true;
    }
    if (Date.now() >= end) return false;
    await sleep(CHECK_EVERY_MS);
  }
}

async function checkStep(page: PageState, options: WhatsAppPageOptions): Promise<[number, string]> {
  let arrived: boolean;
  try {
    arrived = await proofArrived(page, options);
  } catch (error) {
    return [400, checkPage(page, error instanceof ActionFailure ? plain(error.message) : "The relay could not be reached. Try again in a moment.")];
  }
  if (!arrived) return [200, checkPage(page, "No message has arrived yet. Check that the webhook is saved in Meta with the messages field subscribed, send another message, and press Check again.")];
  const { meta, secrets } = page;
  if (!meta || !secrets) return [400, cloudflarePage(page, "Start again from step 1.")];
  await options.store("whatsapp", JSON.stringify({ access_token: meta.access_token, app_secret: meta.app_secret, pull_token: secrets.pull_token, verify_token: secrets.verify_token, path_key: secrets.path_key }));
  await options.store("whatsapp-settings", JSON.stringify({ relay_url: page.relayUrl, phone_number_id: meta.phone_number_id, display_number: meta.display_number }));
  page.finished = true;
  return [200, CONNECTED_PAGE];
}

async function handle(req: IncomingMessage, res: ServerResponse, page: PageState, options: WhatsAppPageOptions, finish: () => void): Promise<void> {
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden");
  if (req.url !== page.path) return send(res, 404, "Not found");
  if (page.finished) return send(res, 410, DONE_PAGE);
  if (req.method === "GET") return send(res, 200, page.step === "cloudflare" ? cloudflarePage(page) : page.step === "meta" ? metaPage(page) : checkPage(page));
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden");
  const form = new URLSearchParams(await readBody(req));
  const step = form.get("step");
  if (step === "cloudflare") return send(res, ...(await relayStep(page, form, options)));
  if (step === "meta" && page.step !== "cloudflare") return send(res, ...(await metaStep(page, form, options)));
  if (step === "check" && page.step === "check") {
    send(res, ...(await checkStep(page, options)));
    if (page.finished) finish();
    return;
  }
  return send(res, 400, cloudflarePage(page, "That step comes later: start with step 1."));
}

export async function startWhatsAppPage(options: WhatsAppPageOptions): Promise<SecretPage> {
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
  const page: PageState = { path, origin: `http://${HOST}:${port}`, finished: false, step: "cloudflare" };
  server.on("request", (req, res) => {
    handle(req, res, page, options, () => close("stored")).catch(() => send(res, 500, cloudflarePage(page, "Something went wrong. Please try again.")));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? LONG_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}
