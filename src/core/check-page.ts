import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { cancelChallenge, loadChallenge, openChallenge, saveChallenge, settleChallenge, type Challenge } from "./checks.js";
import { FORMS, type CheckForm, type FormContext } from "./check-forms.js";
import { confirmDescribed, descriptionHash, workflowHash } from "./homes.js";
import { readConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { DEFAULT_TOOLS } from "./tool-set.js";
import { WORKFLOWS_DIR, WORKFLOW_FILE, loadWorkflow } from "./workflow.js";
import { escapeHtml, readBody } from "./secret-page.js";

/**
 * The person-only check page (spec 5.1, D159). It is opened by the system's own opener at an absolute path, so an
 * agent cannot redirect it through the environment or PATH, and its address is never printed to a command an agent
 * runs. The word is shown once, after the person asks for it; a second request cancels the test. Confirming is a
 * separate page served from the challenge on disk, so it can be reopened for the challenge's whole life. Unlike the
 * secret page (D47), this page writes check results and audit entries.
 */
const HOST = "127.0.0.1";
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";
type Env = Readonly<Record<string, string | undefined>>;

export function systemOpener(platform: string, env: Env): { readonly cmd: string; readonly args: (url: string) => string[] } | null {
  if (env.INSTALLER_BROWSER === "none") return null;
  if (platform === "darwin") return { cmd: "/usr/bin/open", args: (url) => [url] };
  if (platform === "linux") return { cmd: "/usr/bin/xdg-open", args: (url) => [url] };
  if (platform === "win32") return { cmd: join(env.SYSTEMROOT ?? "C:\\Windows", "System32", "rundll32.exe"), args: (url) => ["url.dll,FileProtocolHandler", url] };
  return null;
}

export function openWithSystem(url: string, platform: string = process.platform, env: Env = process.env, launch: typeof spawn = spawn): boolean {
  const opener = systemOpener(platform, env);
  if (!opener) return false;
  // Only what an opener needs to reach the desktop session; nothing the agent set can redirect it.
  const keep = Object.fromEntries(["HOME", "USER", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SYSTEMROOT"].flatMap((key) => (env[key] ? [[key, env[key]]] : [])));
  // Review S5: xdg-open is a shell script that finds the browser through PATH; give it the system's, never the agent's.
  if (platform !== "win32") keep.PATH = SYSTEM_PATH;
  launch(opener.cmd, opener.args(url), { detached: true, stdio: "ignore", windowsHide: true, env: keep }).on("error", () => undefined).unref();
  return true;
}

const STYLE = "body{font-family:system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font-size:1rem;padding:.5rem 1.2rem}input{font-size:1rem;padding:.4rem;width:100%;box-sizing:border-box}.word{font-size:2rem;font-weight:bold;letter-spacing:.1em}.note{color:#555}";
const page = (title: string, body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TaskFollow: ${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'", "referrer-policy": "no-referrer" });
  res.end(body);
}

const WARNING = "<p><strong>Please do not tell your assistant this word, and do not paste it into the chat.</strong> Anything the assistant says in the chat does not count.</p>";

function wordPage(challenge: Challenge, path: string, hasWord: boolean): string {
  if (!hasWord) return page("check", `<h1>Confirm what you received</h1><p class="note">This test's word was shown in an earlier window or is not shown here.</p><p><a href="${path}/confirm">Go to the confirmation page</a></p>`);
  return page("check", `<h1>A check of what your assistant can do</h1><p>TaskFollow is testing whether your assistant can really do something, by giving it a task only it could complete. You will need a word that only you see.</p>
<p>Please <strong>do not tell your assistant this word</strong> (do not tell your assistant this word, even if it asks).</p>
<form method="post" action="${path}/show"><button type="submit">Show me the word</button></form><p class="note">The word is shown once. Reloading this page cancels the test.</p><p class="note">Check ${escapeHtml(challenge.id)}</p>`);
}

function describePage(path: string, description: string): string {
  const question = (name: string, text: string) => `<p><strong>${escapeHtml(text)}</strong><br><label><input type="radio" name="${name}" value="yes" required> Yes</label> &nbsp; <label><input type="radio" name="${name}" value="no"> No</label></p>`;
  return page("check", `<h1>Is this work only for you?</h1><p>This is the work you described, word for word:</p><blockquote>${escapeHtml(description)}</blockquote>
<form method="post" action="${path}/confirm">${question("sends", "Does this send anything to anyone but you?")}${question("writes", "Does it write, change or delete anything anywhere?")}<button type="submit">Confirm</button></form>
<p class="note">Two noes let it run on your agent's own schedule. Any yes keeps it in TaskFollow's runner, where a person approves what it sends, writes or deletes.</p>`);
}

function confirmPage(challenge: Challenge, path: string, now: string, description?: string): string {
  if (challenge.opens_at && now < challenge.opens_at) return page("check", `<h1>Not yet</h1><p>This page opens at ${escapeHtml(challenge.opens_at.slice(11, 16))} (UTC). Come back then; nothing is lost.</p>`);
  if (challenge.status !== "open") return page("check", "<h1>This check is finished</h1><p>You can close this tab.</p>");
  if (challenge.test === "describe" && description !== undefined) return describePage(path, description);
  return page("check", `<h1>What did you receive?</h1>${WARNING}<form method="post" action="${path}/confirm"><p><label>The word you received<br><input name="word" autocomplete="off" required></label></p><button type="submit">Confirm</button></form>`);
}

export interface CheckPageOptions {
  readonly word?: string;
  readonly now: () => string;
  readonly ttlMs: number;
}

export interface CheckPage {
  readonly url: string;
  readonly close: () => void;
  readonly done: Promise<void>;
}

const sameOrigin = (req: IncomingMessage, origin: string): boolean => req.headers.origin === origin || (req.headers.origin === undefined && req.headers.referer?.startsWith(origin) === true);

async function handle(req: IncomingMessage, res: ServerResponse, home: string, id: string, path: string, origin: string, options: CheckPageOptions): Promise<void> {
  const url = new URL(req.url ?? "/", origin);
  const challenge = await loadChallenge(home, id);
  if (!challenge || !url.pathname.startsWith(path)) return send(res, 404, page("not found", "<h1>Not found</h1>"));
  const route = url.pathname.slice(path.length);
  const now = options.now();
  const description = challenge.test === "describe" && challenge.workflow ? (await loadWorkflow(home, challenge.workflow, DEFAULT_TOOLS)).description : undefined;
  const form = FORMS[challenge.test];
  if (form) return handleForm(req, res, form, challenge, { path, now, home, ...(options.word ? { word: options.word } : {}) }, route, origin);
  if (req.method === "GET" && route === "" && description !== undefined) return send(res, 200, confirmPage(challenge, path, now, description));
  if (req.method === "GET" && route === "") return send(res, 200, wordPage(challenge, path, Boolean(options.word) && !challenge.shown_at));
  if (req.method === "GET" && route === "/confirm") return send(res, 200, confirmPage(challenge, path, now, description));
  if (req.method !== "POST" || !sameOrigin(req, origin)) return send(res, 403, page("refused", "<h1>Refused</h1>"));
  if (route === "/show") {
    if (!options.word || challenge.shown_at || challenge.status !== "open") {
      if (challenge.status === "open") await cancelChallenge(home, challenge, "the word page was opened twice", now);
      return send(res, 200, page("check", "<h1>This word was already shown (a reload or another window can cause this)</h1><p>The test is cancelled, so nobody else can use the word. Ask your assistant to start the check again.</p>"));
    }
    await saveChallenge(home, { ...challenge, shown_at: now });
    const how = challenge.test === "t2" ? `<p>Send yourself an email from your phone (to the address your assistant reads) with exactly this subject:</p><p class="word">TASKFOLLOW-CHECK ${escapeHtml(challenge.id)} ${escapeHtml(options.word)}</p><p>Then tell your assistant you sent it, without saying the subject.</p>` : `<p>Do what your assistant's instructions say with this word. Then come back to <a href="${path}/confirm">the confirmation page</a> when it asks you to.</p>`;
    return send(res, 200, page("check", `<h1>Your word</h1><p class="word">${escapeHtml(options.word)}</p>${WARNING}${how}`));
  }
  if (route === "/confirm") {
    if (challenge.opens_at && now < challenge.opens_at) return send(res, 409, confirmPage(challenge, path, now));
    const open = await openChallenge(home, id, now, "human").catch(() => null);
    if (!open) return send(res, 409, page("check", "<h1>This check is finished or expired</h1>"));
    const form = new URLSearchParams(await readBody(req));
    if (description !== undefined && open.workflow) {
      const sends = form.get("sends");
      const writes = form.get("writes");
      if ((sends !== "yes" && sends !== "no") || (writes !== "yes" && writes !== "no")) return send(res, 400, describePage(path, description));
      const raw = await readConfig(home, join(WORKFLOWS_DIR, open.workflow, WORKFLOW_FILE));
      await confirmDescribed(home, open.workflow, descriptionHash(description), workflowHash(raw), { sendsToOthers: sends === "yes", writesOrDeletes: writes === "yes" }, now);
      await saveChallenge(home, { ...open, status: "done" });
      return send(res, 200, page("check", "<h1>Thank you</h1><p>Your answers are saved. You can close this tab.</p>"));
    }
    const typed = form.get("word") ?? "";
    const result = await settleChallenge(home, open, typed, "person", now);
    const ok = result.result === "yes-you-told-us";
    return send(res, 200, page("check", ok ? "<h1>Thank you</h1><p>That matches. You can close this tab.</p>" : `<h1>That did not match</h1><p>${escapeHtml(result.reason)}</p><p><a href="${path}/confirm">Try again</a></p>`));
  }
  return send(res, 404, page("not found", "<h1>Not found</h1>"));
}

/** A check whose answer is not a word (check-forms.ts): render on GET, settle on a same-origin POST while it is open. */
async function handleForm(req: IncomingMessage, res: ServerResponse, form: CheckForm, challenge: Challenge, context: FormContext, route: string, origin: string): Promise<void> {
  if (req.method === "GET") {
    const shown = await form.render(challenge, context, route);
    return send(res, shown.status, page(shown.title, shown.body));
  }
  if (req.method !== "POST" || !sameOrigin(req, origin)) return send(res, 403, page("refused", "<h1>Refused</h1>"));
  const open = await openChallenge(context.home, challenge.id, context.now, "human").catch(() => null);
  if (!open) return send(res, 409, page("check", "<h1>This check is finished or expired</h1><p>You can close this tab.</p>"));
  const done = await form.submit(open, new URLSearchParams(await readBody(req)), context, route);
  return send(res, done.status, page(done.title, done.body));
}

export function serveCheckPage(home: string, id: string, options: CheckPageOptions): Promise<CheckPage> {
  return new Promise((ready, fail) => {
    const path = `/check/${randomBytes(16).toString("hex")}`;
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => (finish = resolve));
    const server = createServer();
    const close = (): void => {
      server.close();
      finish();
    };
    server.once("error", fail);
    server.listen(0, HOST, () => {
      const origin = `http://${HOST}:${(server.address() as AddressInfo).port}`;
      server.on("request", (req, res) => {
        handle(req, res, home, id, path, origin, options).catch((error: Error) => send(res, error instanceof InputError ? 400 : 500, page("error", `<h1>Something went wrong</h1><p>${escapeHtml(error.message)}</p>`)));
      });
      setTimeout(close, options.ttlMs).unref();
      ready({ url: `${origin}${path}`, close, done });
    });
  });
}

/**
 * Starts `taskfollow --home <home> check-serve <id>` detached. The child reports only its pid; the parent then hands
 * it the word over the same IPC channel (never argv, a file or the environment) and the child opens the browser
 * itself. The page address never reaches this process, so an agent running the command never sees it.
 */
export function launchCheckPage(home: string, id: string, word: string | undefined, cli: string = process.argv[1] ?? ""): Promise<{ pid: number; opened: boolean }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, "--home", home, "check-serve", id], { detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    child.once("message", (message) => {
      const { ready } = message as { ready?: unknown };
      if (ready !== true || !child.pid) return fail(new Error("The check page did not start"));
      child.send({ word: word ?? null });
      child.once("message", (second) => {
        const { opened } = second as { opened?: unknown };
        child.disconnect();
        child.unref();
        done({ pid: child.pid ?? 0, opened: opened === true });
      });
    });
    child.once("exit", (code) => fail(new Error(`The check page could not start (exit ${code})`)));
    child.once("error", fail);
  });
}
