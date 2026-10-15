import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { InputError } from "./inputs.js";
import { loadProfileById } from "./profile.js";
import { installerCliPath, shellQuote, winQuote } from "./register.js";
import { loadState } from "./state.js";
import { REASON_NAME } from "./watch-record.js";
import { isToolRule } from "./workflow.js";

/**
 * `taskfollow watch` (D146): an opt-in hook in the person's own Claude Code settings, so calls their agent makes
 * directly to a watched service (outside TaskFollow) are recorded and `taskfollow why direct` can show them. Only the
 * person, at their own terminal, turns it on or off or changes the list. TaskFollow's entry is one PostToolUse hook,
 * marked by its command (`watch-hook.js`); everything else in the file is left as it was. Before each change the file
 * is copied to the home (0600); a change is written to a temporary file and moved into place only if the file did
 * not change meanwhile (Claude Code writes it too). A file that is not plain JSON is never touched.
 */
type Env = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

export const WATCH_MARK = "watch-hook.js";
export const WATCH_CONFIG = join("config", "watch.json");
export const SETTINGS_ENV = "INSTALLER_CLAUDE_SETTINGS";
export const SETTINGS_BACKUP_DIR = join("state", "claude-settings-backup");
const SERVICE = /^(mcp:[A-Za-z0-9_-]+|cli:[A-Za-z0-9_.-]+)$/;
const HOOK_TIMEOUT_S = 5;
const WRITE_ATTEMPTS = 3;

interface WatchState {
  readonly on: boolean;
  readonly services: readonly string[];
  /** D147: the `permissions.ask` rules TaskFollow added (never one the person had already). */
  readonly ask: readonly string[];
  /** D148: the member who asked for "I noticed" suggestions; only they get them. */
  readonly suggest_to?: string;
}

export const settingsPath = (env: Env): string => env[SETTINGS_ENV] || join(homedir(), ".claude", "settings.json");

/** Only the watched services' tools, TaskFollow's reason tool, and Bash when a command-line tool is watched. */
export function watchMatcher(services: readonly string[]): string {
  const servers = services.filter((service) => service.startsWith("mcp:")).map((service) => service.slice(4));
  const parts = [...(servers.length > 0 ? [`mcp__(${servers.join("|")})__.*`] : []), REASON_NAME, ...(services.some((service) => service.startsWith("cli:")) ? ["Bash"] : [])];
  return `^(${parts.join("|")})$`;
}

const ours = (entry: unknown): boolean => isRecord(entry) && Array.isArray(entry.hooks) && entry.hooks.some((hook) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes(WATCH_MARK));

export function settingsWithout(settings: Raw): Raw {
  const hooks = isRecord(settings.hooks) ? settings.hooks : undefined;
  if (!hooks || !Array.isArray(hooks.PostToolUse)) return settings;
  const kept = hooks.PostToolUse.filter((entry) => !ours(entry));
  const { PostToolUse: _old, ...otherHooks } = hooks;
  const nextHooks = kept.length > 0 ? { ...otherHooks, PostToolUse: kept } : otherHooks;
  const { hooks: _hooks, ...rest } = settings;
  return Object.keys(nextHooks).length > 0 ? { ...rest, hooks: nextHooks } : rest;
}

export function settingsWith(settings: Raw, matcher: string, command: string): Raw {
  const base = settingsWithout(settings);
  const hooks = isRecord(base.hooks) ? base.hooks : {};
  const post = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  return { ...base, hooks: { ...hooks, PostToolUse: [...post, { matcher, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] } };
}

function hookCommand(home: string, platform: string = process.platform): string {
  const quote = platform === "win32" ? winQuote : shellQuote;
  return `${quote(process.execPath)} ${quote(join(dirname(installerCliPath()), WATCH_MARK))} ${quote(home)}`;
}

interface SettingsFile {
  readonly value: Raw;
  readonly raw: string | null;
  readonly mark: string | null;
}

const markOf = async (path: string): Promise<string | null> => {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
};

async function readSettings(path: string): Promise<SettingsFile> {
  const mark = await markOf(path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: {}, raw: null, mark: null };
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InputError(`${path} is not plain JSON (comments are not supported here), so TaskFollow did not change it. Fix or remove the comment, then try again.`);
  }
  if (!isRecord(value) || (value.hooks !== undefined && !isRecord(value.hooks)) || (isRecord(value.hooks) && value.hooks.PostToolUse !== undefined && !Array.isArray(value.hooks.PostToolUse))) {
    throw new InputError(`${path} has a shape TaskFollow does not expect (hooks.PostToolUse must be a list), so it did not change it.`);
  }
  return { value, raw, mark };
}

/** Applies `change` to the settings file without losing a change Claude Code made at the same moment. */
async function changeSettings(home: string, path: string, change: (settings: Raw) => Raw, now: string): Promise<void> {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const current = await readSettings(path);
    const next = change(current.value);
    if (current.raw !== null) {
      const dir = join(home, SETTINGS_BACKUP_DIR);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const backup = join(dir, `${now.replace(/[:.]/g, "-")}.json`);
      await copyFile(path, backup);
      await chmod(backup, 0o600);
    }
    await mkdir(dirname(path), { recursive: true });
    const mode = current.raw === null ? 0o600 : (await stat(path)).mode & 0o777;
    const temp = `${path}.taskfollow-${process.pid}`;
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
    if ((await markOf(path)) === current.mark) {
      await rename(temp, path);
      return;
    }
    await rm(temp, { force: true });
  }
  throw new InputError(`${path} kept changing while TaskFollow tried to update it (Claude Code may be saving it): close Claude Code's settings and try again.`);
}

export async function loadWatch(home: string): Promise<WatchState> {
  const raw = await readConfig(home, WATCH_CONFIG);
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  if (!isRecord(raw)) return { on: false, services: [], ask: [] };
  return { on: raw.on === true, services: strings(raw.services), ask: strings(raw.ask), ...(typeof raw.suggest_to === "string" ? { suggest_to: raw.suggest_to } : {}) };
}

function requireService(arg: string | undefined): string {
  if (!arg || !SERVICE.test(arg)) throw new InputError("Name a service as mcp:<server> or cli:<tool>, for example: taskfollow watch add mcp:shopify, or taskfollow watch add cli:shopify");
  return arg;
}

async function apply(home: string, state: WatchState, env: Env, now: string): Promise<Raw | null> {
  const path = settingsPath(env);
  if (!state.on || state.services.length === 0) {
    await changeSettings(home, path, settingsWithout, now);
    return null;
  }
  const matcher = watchMatcher(state.services);
  const command = hookCommand(home);
  await changeSettings(home, path, (settings) => settingsWith(settings, matcher, command), now);
  return { file: path, matcher, command };
}

const askRules = (settings: Raw): string[] => {
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  return Array.isArray(permissions.ask) ? permissions.ask.filter((rule): rule is string => typeof rule === "string") : [];
};

/** D147: the person's always-ask rules, as Claude Code's own `permissions.ask`: these cannot fail open like a hook. */
export function settingsWithAsk(settings: Raw, rules: readonly string[]): Raw {
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const current = askRules(settings);
  return { ...settings, permissions: { ...permissions, ask: [...current, ...rules.filter((rule) => !current.includes(rule))] } };
}

export function settingsWithoutAsk(settings: Raw, rules: readonly string[]): Raw {
  if (!isRecord(settings.permissions)) return settings;
  const { ask: _ask, ...others } = settings.permissions;
  const kept = askRules(settings).filter((rule) => !rules.includes(rule));
  const permissions = kept.length > 0 ? { ...others, ask: kept } : others;
  if (Object.keys(permissions).length > 0) return { ...settings, permissions };
  const { permissions: _empty, ...rest } = settings;
  return rest;
}

function requireRule(arg: string | undefined): string {
  if (!arg || !isToolRule(arg)) throw new InputError("Name the tool to always ask about as mcp__<server>__<tool>, mcp__<server>, or Bash(<command>:*), for example: taskfollow watch ask mcp__shopify__create_refund");
  return arg;
}

async function changeAsk(home: string, state: WatchState, sub: "ask" | "unask", rule: string, env: Env, now: string): Promise<WatchState> {
  const path = settingsPath(env);
  if (sub === "unask") {
    if (state.ask.includes(rule)) await changeSettings(home, path, (settings) => settingsWithoutAsk(settings, [rule]), now);
    return { ...state, ask: state.ask.filter((entry) => entry !== rule) };
  }
  if (askRules((await readSettings(path)).value).includes(rule)) return state;
  await changeSettings(home, path, (settings) => settingsWithAsk(settings, [rule]), now);
  return { ...state, ask: [...state.ask, rule] };
}

/** Turning watching or always-ask on edits Claude Code's settings, so it is refused for a person whose agent is another one. */
async function requireClaudeSettings(home: string): Promise<void> {
  const id = (await loadState(home))?.runtime?.profile;
  if (!id) return;
  const profile = await loadProfileById(id);
  if (profile.personal_settings !== "claude") {
    throw new InputError(`Watching and always-ask work only with Claude Code for now; your agent is ${profile.name}. TaskFollow did not change anything.`);
  }
}

export async function watchCommand(home: string, request: { readonly sub: string | undefined; readonly arg?: string; readonly interactive: boolean }, now: () => string, env: Env = process.env): Promise<Raw> {
  const state = await loadWatch(home);
  const sub = request.sub ?? "list";
  if (sub === "list") return { on: state.on, services: [...state.services], ask: [...state.ask], ...(state.suggest_to ? { suggest_to: state.suggest_to } : {}) };
  if (!["on", "off", "add", "remove", "ask", "unask", "suggest"].includes(sub)) throw new InputError("watch takes: list, add <service>, remove <service>, on, off, ask <tool rule>, unask <tool rule>, suggest <your member name>|off");
  if (!request.interactive) {
    await appendAudit(home, { ts: now(), actor: "agent", event: "watch.refused", ref: "watch", payload: { sub } });
    throw new InputError("Watching the agent's direct calls is the person's choice: they run 'taskfollow watch " + sub + "' in their own terminal");
  }
  if (sub === "suggest") {
    const name = request.arg?.trim();
    if (!name) throw new InputError("Say who gets the suggestions: taskfollow watch suggest \"<your member name>\" (or off)");
    const { suggest_to: _old, ...rest } = state;
    const changed: WatchState = name === "off" ? rest : { ...rest, suggest_to: name };
    await writeConfig(home, WATCH_CONFIG, changed);
    await appendAudit(home, { ts: now(), actor: "human", event: "watch.suggest", ref: "watch", payload: { to: changed.suggest_to ?? null } });
    return { on: changed.on, services: [...changed.services], ask: [...changed.ask], ...(changed.suggest_to ? { suggest_to: changed.suggest_to } : {}) };
  }
  if (sub === "on" || sub === "ask") await requireClaudeSettings(home);
  if (sub === "ask" || sub === "unask") {
    const changed = await changeAsk(home, state, sub, requireRule(request.arg), env, now());
    await writeConfig(home, WATCH_CONFIG, changed);
    await appendAudit(home, { ts: now(), actor: "human", event: `watch.${sub}`, ref: "watch", payload: { rule: request.arg, ask: changed.ask } });
    return { on: changed.on, services: [...changed.services], ask: [...changed.ask], note: "Claude Code now asks the person before these tools run in their own sessions; restart open sessions." };
  }
  let next: WatchState = state;
  if (sub === "add") next = { ...state, services: [...new Set([...state.services, requireService(request.arg)])] };
  if (sub === "remove") next = { ...state, services: state.services.filter((service) => service !== requireService(request.arg)) };
  if (sub === "on") {
    if (state.services.length === 0) throw new InputError("Nothing to watch yet: first run 'taskfollow watch add mcp:<server>' or 'taskfollow watch add cli:<tool>'");
    next = { ...state, on: true };
  }
  if (sub === "off") next = { ...state, on: false };
  const wrote = sub === "add" || sub === "remove" ? (next.on ? await apply(home, next, env, now()) : null) : await apply(home, next, env, now());
  await writeConfig(home, WATCH_CONFIG, next);
  await appendAudit(home, { ts: now(), actor: "human", event: `watch.${sub}`, ref: "watch", payload: { services: next.services, on: next.on } });
  return {
    on: next.on, services: [...next.services], ...(wrote ? { wrote } : {}),
    ...(sub === "on" ? { restart: "Restart any open Claude Code sessions: they read their settings when they start.", records: "Each watched call keeps only the tool, the first words of a command or the names of its arguments, never their values." } : {}),
  };
}

/** Uninstall (D146): the entry leaves the person's settings first, so nothing points at a removed program. */
export async function stopWatching(home: string, env: Env, now: string): Promise<boolean> {
  const state = await loadWatch(home);
  if (!state.on && state.ask.length === 0) return false;
  await changeSettings(home, settingsPath(env), (settings) => settingsWithoutAsk(settingsWithout(settings), state.ask), now);
  await writeConfig(home, WATCH_CONFIG, { ...state, on: false, ask: [] });
  return true;
}

/** `doctor`: when watching is on, TaskFollow's entry is still in the settings and the programs it names exist. */
export async function watchHealth(home: string, env: Env): Promise<{ readonly on: boolean; readonly problem?: string }> {
  const state = await loadWatch(home);
  if (!state.on) return { on: false };
  const settings = await readSettings(settingsPath(env));
  const hooks = isRecord(settings.value.hooks) && Array.isArray(settings.value.hooks.PostToolUse) ? settings.value.hooks.PostToolUse : [];
  const entry = hooks.find(ours);
  if (!entry) return { on: true, problem: "TaskFollow's entry is no longer in the Claude Code settings" };
  const command = String(((entry as { hooks: Raw[] }).hooks.find((hook) => String(hook.command).includes(WATCH_MARK)) ?? {}).command ?? "");
  const paths = [...command.matchAll(/'([^']*)'|"([^"]*)"/g)].map((match) => match[1] ?? match[2] ?? "").slice(0, 2);
  for (const path of paths) {
    try {
      await stat(path);
    } catch {
      return { on: true, problem: `the program the hook runs is missing (${path})` };
    }
  }
  return { on: true };
}
