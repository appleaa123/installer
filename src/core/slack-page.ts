import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ActionFailure } from "./failure.js";
import { DONE_PAGE, LONG_PAGE_TTL_MS, escapeHtml, listen, readBody, type SecretPage } from "./secret-page.js";
import { slackApi, type SlackIdentity, type SlackTokens } from "./slack.js";
import { waitForHello } from "./slack-socket.js";

/**
 * `taskfollow secret slack` (D135): the same detached loopback page as the others. The person creates a Slack app from a
 * manifest (so the right permissions and Socket Mode are set for them), installs it to their workspace, and pastes two
 * tokens. The page proves the bot token, the app token and the live connection, and only then stores the tokens as
 * `slack` and the workspace details as `slack-settings`; `taskfollow channel slack` finishes from those. Nothing typed
 * here reaches the agent, and the page keeps nothing between requests.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type SlackSettings = SlackIdentity & { readonly app_id: string };

export interface SlackPageOptions {
  readonly store: (id: string, value: string) => Promise<void>;
  /** Proves the tokens and says which workspace and app they belong to; defaults to the real calls. */
  readonly check?: (tokens: SlackTokens) => Promise<SlackSettings>;
  readonly ttlMs?: number;
  readonly env?: Env;
}

/** Direct messages to the app only: three permissions and one event, nothing in channels (D135). */
export const SLACK_MANIFEST = JSON.stringify({
  display_information: { name: "TaskFollow" },
  features: { bot_user: { display_name: "taskfollow", always_online: true }, app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false } },
  oauth_config: { scopes: { bot: ["chat:write", "im:history", "im:write"] } },
  settings: { event_subscriptions: { bot_events: ["message.im"] }, socket_mode_enabled: true, org_deploy_enabled: false, token_rotation_enabled: false },
});

const HOST = "127.0.0.1";
const CSS = "body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}label{display:block;margin-top:1rem}input,textarea{width:100%;font-size:1rem;padding:.5rem;box-sizing:border-box}textarea{height:8rem;font-family:ui-monospace,monospace;font-size:.8rem}button{margin-top:1.5rem;font-size:1rem;padding:.6rem 1.2rem}.error{color:#a40000;font-weight:600}.note{color:#555}li{margin-bottom:.6rem}";

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" });
  res.end(body);
}

const layout = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TaskFollow: connect Slack</title><style>${CSS}</style></head><body>${body}</body></html>`;

function formPage(action: string, error?: string): string {
  return layout(`<h1>Connect Slack</h1>
<p>This page is served by TaskFollow on this computer only. Nothing you type here goes to your AI assistant.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<ol>
<li>Open <a href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener">api.slack.com/apps</a>, choose <b>Create New App</b>, then <b>From a manifest</b>. Pick your workspace, paste the text below, press <b>Next</b>, then <b>Create</b>.</li>
<li>Press <b>Install to Workspace</b> and <b>Allow</b>. If Slack says <b>Request to Install</b>, a workspace owner must approve it; come back here afterwards (this page stays open for half an hour).</li>
<li>Open <b>OAuth &amp; Permissions</b> and copy the <b>Bot User OAuth Token</b> (it starts with <code>xoxb-</code>) into the first box.</li>
<li>Open <b>Basic Information</b>, scroll to <b>App-Level Tokens</b>, press <b>Generate Token and Scopes</b>, name it <code>taskfollow</code>, add the permission <code>connections:write</code>, press <b>Generate</b>, and copy the token (it starts with <code>xapp-</code>) into the second box.</li>
</ol>
<label>Manifest to paste in step 1<textarea readonly>${escapeHtml(SLACK_MANIFEST)}</textarea></label>
<form method="post" action="${action}">
<label>Bot User OAuth Token<input type="password" name="bot" autocomplete="off" required></label>
<label>App-Level Token<input type="password" name="app" autocomplete="off" required></label>
<button type="submit">Test and save</button><p class="note">The test signs in to Slack and opens the live connection. It sends no message. It can take a few seconds.</p></form>`);
}

const CONNECTED_PAGE = layout("<h1>Connected</h1><p>Slack is connected. Go back to the chat and tell your assistant. You can close this tab.</p>");

/** Page wording for a failure: the engine's own advice about a terminal command makes no sense on this page. */
const plain = (message: string): string => message.replace(/: run 'taskfollow secret slack' again/g, "; copy the token again from the app's settings");

async function realCheck(tokens: SlackTokens, env: Env): Promise<SlackSettings> {
  const api = slackApi(tokens, env);
  const refused = (name: string, hint: string) => (error: unknown): never => {
    const message = (error as Error).message;
    throw new ActionFailure(message.startsWith("Cannot reach") ? message : `Slack did not accept the ${name}. ${hint}`);
  };
  const who = await api.authTest().catch(refused("Bot User OAuth Token", "Copy it again from OAuth & Permissions, after installing the app (it starts with xoxb-)."));
  const url = await api.connectionsOpen().catch(refused("App-Level Token", "Make sure it was made with the connections:write permission, and that you copied all of it (it starts with xapp-)."));
  const { app_id } = await waitForHello(url, env);
  return { ...who, app_id };
}

async function handle(req: IncomingMessage, res: ServerResponse, page: { path: string; origin: string; finished: boolean }, options: SlackPageOptions, finish: () => void): Promise<void> {
  if (req.headers.host !== page.origin.slice("http://".length)) return send(res, 403, "Forbidden");
  if (req.url !== page.path) return send(res, 404, "Not found");
  if (page.finished) return send(res, 410, DONE_PAGE);
  if (req.method === "GET") return send(res, 200, formPage(page.path));
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (req.headers.origin !== page.origin) return send(res, 403, "Forbidden");
  const form = new URLSearchParams(await readBody(req));
  const tokens = { bot: (form.get("bot") ?? "").trim(), app: (form.get("app") ?? "").trim() };
  if (!tokens.bot.startsWith("xoxb-")) return send(res, 400, formPage(page.path, "The first box needs the Bot User OAuth Token, which starts with xoxb-."));
  if (!tokens.app.startsWith("xapp-")) return send(res, 400, formPage(page.path, "The second box needs the App-Level Token, which starts with xapp-."));
  let settings: SlackSettings;
  try {
    settings = await (options.check ?? ((checked) => realCheck(checked, options.env ?? process.env)))(tokens);
  } catch (error) {
    return send(res, 400, formPage(page.path, plain(error instanceof ActionFailure ? error.message : "Slack could not be reached. Check your internet connection and try again.")));
  }
  await options.store("slack", JSON.stringify(tokens));
  await options.store("slack-settings", JSON.stringify(settings));
  page.finished = true;
  send(res, 200, CONNECTED_PAGE);
  finish();
}

export async function startSlackPage(options: SlackPageOptions): Promise<SecretPage> {
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
  const page = { path, origin: `http://${HOST}:${port}`, finished: false };
  server.on("request", (req, res) => {
    handle(req, res, page, options, () => close("stored")).catch(() => send(res, 500, formPage(path, "Something went wrong. Please try again.")));
  });
  setTimeout(() => close("expired"), options.ttlMs ?? LONG_PAGE_TTL_MS).unref();
  return { url: `${page.origin}${path}`, done, close: () => close("expired") };
}
