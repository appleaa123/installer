import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseEmailSetup } from "./channel-commands.js";
import type { EmailConfig } from "./channels.js";
import { MAILBOX } from "./email-channel.js";
import { explainMailFailure, normalizePassword, presetFor, setupFromPreset, type Preset, type PresetResult } from "./email-presets.js";
import { withImap } from "./imap.js";
import { InputError } from "./inputs.js";
import { requireSecretValue } from "./keychain.js";
import { DONE_PAGE, LONG_PAGE_TTL_MS, escapeHtml, listen, readBody, type SecretPage } from "./secret-page.js";
import { smtpVerify } from "./smtp.js";

/**
 * `taskfollow secret email` (D127): the same detached loopback page as D47, in two steps. Step 1 takes the person's
 * address; step 2 shows how to make an app password at that provider and takes the password. The page then signs in
 * to the mailbox (reading and sending are checked, nothing is sent or marked read) and only a working pair is
 * stored: the password as `email`, the servers as `email-settings`. The servers come from the provider table or from
 * fields the person types in their own browser, and the page keeps nothing between requests, so the agent cannot
 * choose where the app password goes (D73, D77).
 */
type Setup = Omit<EmailConfig, "verified_at">;
type Env = Readonly<Record<string, string | undefined>>;

export interface EmailPageOptions {
  readonly store: (id: string, value: string) => Promise<void>;
  /** Signs in to both servers; defaults to the real IMAP and SMTP checks. */
  readonly check?: (setup: Setup, password: string) => Promise<void>;
  readonly ttlMs?: number;
  readonly env?: Env;
}

const HOST = "127.0.0.1";
const FIELDS = ["imap_host", "imap_port", "imap_security", "imap_user", "smtp_host", "smtp_port", "smtp_security", "smtp_user"] as const;
type FieldName = (typeof FIELDS)[number];
type Values = Readonly<Record<FieldName, string>>;

const CSS = "body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}label{display:block;margin-top:1rem}input,select{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}button{margin-top:1.5rem;font-size:1rem;padding:.6rem 1.2rem}.error{color:#a40000;font-weight:600}.note{color:#555}details{margin-top:1.5rem;padding:.5rem 1rem;border:1px solid #ccc;border-radius:6px}";

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(body);
}

const layout = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TaskFollow: connect your mailbox</title><style>${CSS}</style></head><body>${body}</body></html>`;
const notice = (error?: string): string => (error ? `<p class="error">${escapeHtml(error)}</p>` : "");

function addressPage(action: string, error?: string, address = ""): string {
  return layout(`<h1>Connect your mailbox</h1>
<p>This page is served by TaskFollow on this computer only. Nothing you type here goes to your AI assistant.</p>${notice(error)}
<form method="post" action="${action}"><input type="hidden" name="step" value="address"><label>Your email address<input type="email" name="address" value="${escapeHtml(address)}" autocomplete="off" autofocus required></label><button type="submit">Continue</button></form>`);
}

/** The servers to show when the person has not typed any: the provider's, or a guess from the domain. */
function defaultValues(address: string, resolved: PresetResult): Values {
  const domain = address.split("@")[1] ?? "example.com";
  const setup: Setup = resolved.kind === "preset"
    ? setupFromPreset(address, resolved.preset)
    : { channel: "email", address, imap: { host: `imap.${domain}`, port: 993, security: "ssl", user: address }, smtp: { host: `smtp.${domain}`, port: 465, security: "ssl", user: address } };
  return {
    imap_host: setup.imap.host, imap_port: String(setup.imap.port), imap_security: setup.imap.security, imap_user: setup.imap.user,
    smtp_host: setup.smtp.host, smtp_port: String(setup.smtp.port), smtp_security: setup.smtp.security, smtp_user: setup.smtp.user,
  };
}

const field = (name: FieldName, label: string, values: Values): string => `<label>${label}<input name="${name}" value="${escapeHtml(values[name])}" autocomplete="off"></label>`;
const security = (name: "imap_security" | "smtp_security", label: string, values: Values): string =>
  `<label>${label}<select name="${name}">${["ssl", "starttls"].map((option) => `<option value="${option}"${values[name] === option ? " selected" : ""}>${option === "ssl" ? "SSL (secure from the start)" : "STARTTLS"}</option>`).join("")}</select></label>`;

function helpBlock(resolved: PresetResult, address: string): string {
  if (resolved.kind === "preset") {
    const { preset } = resolved;
    return `<p>We recognised <b>${escapeHtml(preset.name)}</b>. To connect it, make an <b>app password</b>: a separate password just for TaskFollow, so your normal password stays private.</p>
<ol>${preset.help.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol><p class="note">${escapeHtml(preset.help.missing)}</p>`;
  }
  const domain = address.split("@")[1] ?? "";
  return `<p>We do not know this provider's settings. Open <b>Advanced</b> below and enter the values from your provider's help pages (search for "${escapeHtml(domain)} IMAP settings"). Use only values from your provider: they decide where your password goes. If your provider asks for an app password, make one first.</p>`;
}

function connectPage(action: string, address: string, resolved: PresetResult, values: Values, error?: string): string {
  if (resolved.kind === "unsupported") {
    return layout(`<h1>${escapeHtml(resolved.name)}</h1><p>${escapeHtml(resolved.reason)}</p>
<form method="post" action="${action}"><input type="hidden" name="step" value="address"><label>Use a different address<input type="email" name="address" autocomplete="off" required></label><button type="submit">Continue</button></form>`);
  }
  const open = resolved.kind === "unknown" ? " open" : "";
  return layout(`<h1>Connect ${escapeHtml(address)}</h1>${helpBlock(resolved, address)}${notice(error)}
<form method="post" action="${action}"><input type="hidden" name="step" value="connect"><input type="hidden" name="address" value="${escapeHtml(address)}">
<label>App password<input type="password" name="password" autocomplete="off" autofocus required></label>
<details${open}><summary>Advanced: mail servers</summary>
${field("imap_host", "Incoming server (IMAP)", values)}${field("imap_port", "Incoming port", values)}${security("imap_security", "Incoming security", values)}${field("imap_user", "Incoming sign-in name", values)}
${field("smtp_host", "Outgoing server (SMTP)", values)}${field("smtp_port", "Outgoing port", values)}${security("smtp_security", "Outgoing security", values)}${field("smtp_user", "Outgoing sign-in name", values)}
</details><button type="submit">Test and save</button><p class="note">The test reads your inbox and checks the sign-in for sending. It sends nothing and marks nothing as read. It can take up to a minute.</p></form>`);
}

const CONNECTED_PAGE = layout("<h1>Connected</h1><p>Your mailbox is connected. Go back to the chat and tell your assistant. You can close this tab.</p>");

interface PageState {
  readonly path: string;
  readonly origin: string;
  finished: boolean;
}

const defaultCheck = (env: Env) => async (setup: Setup, password: string): Promise<void> => {
  await withImap(setup.imap, password, (session) => session.examine(MAILBOX), env);
  await smtpVerify(setup.smtp, password, env);
};

function valuesOf(form: URLSearchParams): Values {
  return Object.fromEntries(FIELDS.map((name) => [name, (form.get(name) ?? "").trim()])) as Values;
}

async function connect(form: URLSearchParams, res: ServerResponse, page: PageState, options: EmailPageOptions, finish: () => void): Promise<void> {
  const address = (form.get("address") ?? "").trim().toLowerCase();
  const resolved = presetFor(address);
  const values = valuesOf(form);
  const again = (message: string): void => send(res, 400, connectPage(page.path, address, resolved, values, message));
  const preset: Preset | undefined = resolved.kind === "preset" ? resolved.preset : undefined;
  let setup: Setup;
  let password: string;
  try {
    const account = (kind: "imap" | "smtp") => ({ host: values[`${kind}_host`], port: Number(values[`${kind}_port`]), security: values[`${kind}_security`], ...(values[`${kind}_user`] ? { user: values[`${kind}_user`] } : {}) });
    setup = parseEmailSetup(JSON.stringify({ address, imap: account("imap"), smtp: account("smtp") }));
    if ((form.get("password") ?? "").trim() === "") throw new InputError("Enter the app password.");
    password = normalizePassword(requireSecretValue((form.get("password") ?? "").trim()), preset);
  } catch (error) {
    return again(error instanceof InputError ? `Check the form: ${error.message}` : "Check the form and try again.");
  }
  try {
    await (options.check ?? defaultCheck(options.env ?? process.env))(setup, password);
  } catch (error) {
    return again(explainMailFailure((error as Error).message, preset));
  }
  await options.store("email", password);
  await options.store("email-settings", JSON.stringify(setup));
  page.finished = true;
  send(res, 200, CONNECTED_PAGE);
  finish();
}

async function handle(req: IncomingMessage, res: ServerResponse, page: PageState, options: EmailPageOptions, finish: () => void): Promise<void> {
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden");
  if (req.url !== page.path) return send(res, 404, "Not found");
  if (page.finished) return send(res, 410, DONE_PAGE);
  if (req.method === "GET") return send(res, 200, addressPage(page.path));
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden");
  const form = new URLSearchParams(await readBody(req));
  if (form.get("step") === "connect") return connect(form, res, page, options, finish);
  const address = (form.get("address") ?? "").trim().toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(address)) return send(res, 400, addressPage(page.path, "Enter your email address, for example name@example.com.", address));
  const resolved = presetFor(address);
  send(res, 200, connectPage(page.path, address, resolved, defaultValues(address, resolved)));
}

export async function startEmailPage(options: EmailPageOptions): Promise<SecretPage> {
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
    handle(req, res, page, options, () => close("stored")).catch(() => send(res, 500, addressPage(path, "Something went wrong. Please try again.")));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? LONG_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}
