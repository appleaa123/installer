import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import { channelCheck } from "./channels.js";
import { mappingCheck, sourceCheck } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { deriveModeAction } from "./mode.js";
import { oauthReady } from "./oauth-ready.js";
import { listBundledProfiles, loadProfileById, type RuntimeProfile } from "./profile.js";
import { probeMcp, runProbe, withMcpProbe } from "./probe.js";
import { setSandboxMode } from "./sandbox.js";
import { TOOLS_MCP_NAME, headersHelperCommand, installerCliPath, registerMcp, registerMcpConfig, toolsServerConfig } from "./register.js";
import { SKILLSWIKI_MCP_NAME, SKILLSWIKI_SECRET_ID, activeComboSlug, skillswikiTarget } from "./skillswiki.js";
import type { Action, CapabilityMap, Check, InstallState, StatePatch } from "./types.js";

export interface CheckResult {
  readonly ok: boolean;
  readonly hint?: string;
}

type Args = Readonly<Record<string, unknown>>;

/** Every file the engine touches must stay inside engine_home (D34). */
export function resolveInHome(home: string, relative: string): string {
  const root = resolve(home);
  const target = resolve(root, relative);
  if (target === root || !target.startsWith(root + sep)) {
    throw new InputError(`Path '${relative}' is outside the engine home`);
  }
  return target;
}

/** resolveInHome, plus a refusal of any link below the home that could lead outside it (D34). */
export async function confinedPath(home: string, relative: string): Promise<string> {
  const target = resolveInHome(home, relative);
  let path = resolve(home);
  for (const part of relativePath(path, target).split(sep)) {
    path = resolve(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new InputError(`Path '${relative}' goes through a symbolic link`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw error;
    }
  }
  return target;
}

function stringArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new InputError(`Argument '${key}' must be a string`);
  return value;
}

/** Working folder for headless agent calls made by the probe, inside the engine home (D34). */
export const PROBE_DIR = join("runtime", "probe");
const NO_AGENT_HINT = "The probe found no known agent to register Skills Wiki in; install a supported agent, then run 'taskfollow resume'";
const CLI_TOOLS_CLAUSE = "use 'taskfollow tool <name> <json>' for TaskFollow's tools (INSTALL.md section 5); the install goes on";
const NO_AGENT_TOOLS_HINT = `TaskFollow has no profile for this agent, so its tools are not connected over MCP: ${CLI_TOOLS_CLAUSE}`;
const NO_COMBO_HINT = "No combo is active in Skills Wiki yet: activate one in your dashboard, then run 'taskfollow resume'";
const now = (): string => new Date().toISOString();
/** Loaded when used: the lifecycle reaches the runner and the gateway, which import this module (confinedPath). */
const lifecycle = () => import("./lifecycle.js");

/** ACTIVATE (D98): the engine leaves sandbox only when the person confirmed a dry run of every workflow's current version. */
async function leaveSandbox(home: string): Promise<StatePatch> {
  const open = (await (await lifecycle()).lifecycleStatus(home)).filter((row) => !row.confirmed).map((row) => row.id);
  if (open.length > 0) throw new ActionFailure(`Not confirmed yet: ${open.join(", ")}. The person reads 'taskfollow dryrun' and runs 'taskfollow dryrun confirm <workflow>' in their own terminal; then run 'taskfollow resume'`);
  await setSandboxMode(home, false, "engine", now());
  return {};
}

/** ACTIVATE: the gateway receives messages and announces approvals from now on (D72); a failure is the person's to fix. */
async function startGatewayAction(home: string): Promise<StatePatch> {
  try {
    await (await import("./gateway-process.js")).startGateway(home, now);
  } catch (error) {
    if (error instanceof InputError) throw new ActionFailure(`${error.message}; then run 'taskfollow resume'`);
    throw error;
  }
  return {};
}

/** A channel added after the install: the running gateway must start again to read it (D134). */
async function restartGatewayAction(home: string): Promise<StatePatch> {
  try {
    await (await import("./gateway-process.js")).restartGateway(home, now);
  } catch (error) {
    if (error instanceof InputError) throw new ActionFailure(`${error.message}; then run 'taskfollow resume'`);
    throw error;
  }
  return {};
}

async function probeDir(home: string): Promise<string> {
  const cwd = await confinedPath(home, PROBE_DIR);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  return cwd;
}

/** The capability map and profile the probe recorded; without them Skills Wiki cannot be registered (fallbacks are later plans). */
async function probedRuntime(state: InstallState | undefined, hint = NO_AGENT_HINT): Promise<{ runtime: CapabilityMap; profile: RuntimeProfile }> {
  const runtime = state?.runtime;
  if (!runtime?.profile) throw new ActionFailure(hint);
  return { runtime, profile: await loadProfileById(runtime.profile) };
}

type ActionRun = (home: string, args: Args, state: InstallState | undefined) => Promise<StatePatch>;

const ACTIONS: Readonly<Record<string, ActionRun>> = {
  noop: async () => ({}),
  /** D163: the consult's report for the client, scrubbed, under the home's exports. */
  consult_report: async (home, _args, state) => {
    await (await import("./consult.js")).consultReport(home, state, now());
    return {};
  },
  /** D165, D172: the find-my-repetitive-work skill, there before the interview. */
  discovery_skill: async (home) => {
    await (await import("./workflow-skill.js")).writeDiscoverySkill(home);
    return {};
  },
  /** D163: the end of a consult; only the results and the interview's workflows stay. */
  consult_cleanup: async (home, _args, state) => {
    await (await import("./consult.js")).consultCleanup(home, state, now());
    return {};
  },
  write_file: async (home, args) => {
    const target = await confinedPath(home, stringArg(args, "path"));
    const content = args.content === undefined ? "" : stringArg(args, "content");
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      throw new ActionFailure(`Cannot write ${stringArg(args, "path")} (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
    return {};
  },
  probe_runtime: async (home, args) => {
    const profiles = typeof args.profile === "string" ? [await loadProfileById(args.profile)] : await listBundledProfiles();
    return { runtime: await runProbe({ profiles, cwd: await probeDir(home) }) };
  },
  derive_mode: async (_home, args, state) => deriveModeAction(args, state),
  register_mcp: async (home, _args, state) => {
    const { profile } = await probedRuntime(state);
    const { url } = await skillswikiTarget(state?.skillswiki?.url);
    const helper = headersHelperCommand(SKILLSWIKI_SECRET_ID, process.execPath, installerCliPath());
    await registerMcp(profile, SKILLSWIKI_MCP_NAME, url, helper, await probeDir(home));
    return {};
  },
  /** D56: the agent reaches the installer's own tools over MCP, as `taskfollow --home <home> mcp-serve`. */
  register_tools_mcp: async (home, _args, state) => {
    const { profile } = await probedRuntime(state, NO_AGENT_TOOLS_HINT);
    try {
      await registerMcpConfig(profile, TOOLS_MCP_NAME, toolsServerConfig(process.execPath, installerCliPath(), resolve(home)), await probeDir(home));
    } catch (error) {
      // D175, review of PR #64: whatever stops the registration, the person can still use the tools from the shell.
      if (error instanceof ActionFailure) throw new ActionFailure(`${error.message}; ${CLI_TOOLS_CLAUSE}`);
      throw error;
    }
    return {};
  },
  /** C6 (D54): runs in the agent's own folder, allowing exactly the registered server's get_active_combo tool. */
  /** WORKFLOWS (D91): from here until ACTIVATE, every message is recorded and every run is a sandbox run. */
  enter_sandbox: async (home) => {
    await setSandboxMode(home, true, "engine", now());
    return {};
  },
  leave_sandbox: async (home) => leaveSandbox(home),
  start_gateway: async (home) => startGatewayAction(home),
  restart_gateway: async (home) => restartGatewayAction(home),
  probe_mcp: async (home, _args, state) => {
    const { runtime, profile } = await probedRuntime(state);
    const expectedSlug = await activeComboSlug(await skillswikiTarget(state?.skillswiki?.url));
    if (!expectedSlug) throw new ActionFailure(NO_COMBO_HINT);
    const cwd = state?.work_dir ?? (await probeDir(home));
    return { runtime: withMcpProbe(runtime, await probeMcp({ profile, cwd, serverName: SKILLSWIKI_MCP_NAME, expectedSlug })) };
  },
};

type CheckRun = (home: string, args: Args, state: InstallState | undefined) => Promise<CheckResult>;

const CHECKS: Readonly<Record<string, CheckRun>> = {
  file_exists: async (home, args) => {
    const path = stringArg(args, "path");
    try {
      await access(await confinedPath(home, path));
      return { ok: true };
    } catch (error) {
      if (error instanceof InputError) throw error;
      return { ok: false, hint: typeof args.hint === "string" ? args.hint : `Expected ${path} to exist` };
    }
  },
  secret_present: async (_home, args) => {
    const id = stringArg(args, "id");
    if ((await getSecret(id)) !== null) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : `No '${id}' key is stored yet: run 'taskfollow secret ${id}', enter it on the page that opens, then run the verify again` };
  },
  /** Live setup guides 4.5: the connector's sign-in works and its API answers (the person's own Google app is set up right). */
  oauth_ready: async (_home, args) => oauthReady(stringArg(args, "id")),
  /** D37: the person activates the combo in the Skills Wiki dashboard; the engine asks get_active_combo itself. */
  combo_active: async (_home, args, state) => {
    if (await activeComboSlug(await skillswikiTarget(state?.skillswiki?.url))) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again" };
  },
  /** §9.4: the agent connected the entity with `taskfollow connect` (D68). */
  source_present: async (home, args) => sourceCheck(home, stringArg(args, "entity")),
  /** §9.4: the person confirmed a mapping that `taskfollow map` checked against the sheet (D68). */
  mapping_present: async (home, args) => mappingCheck(home, stringArg(args, "entity")),
  /** §6.2 CHANNELS: the agent set the channel up with `taskfollow channel <id>`, which checked it live (D73). */
  channel_verified: async (home, args) => channelCheck(home, stringArg(args, "channel")),
  /** §6.2 CHANNELS: the decision maker joined from a channel (D77), so approvals and urgent alerts reach them. */
  decision_maker_joined: async (home, _args, state) => {
    const name = state?.roles?.decision_maker.trim().toLowerCase();
    const members = await (await import("./members.js")).listMembers(home, now());
    if (name && members.some((member) => member.status === "joined" && member.name.toLowerCase() === name)) return { ok: true };
    return { ok: false, hint: "The decision maker has not joined yet: they run 'taskfollow invite \"<their name>\"' in their own terminal and follow the line it prints (on Telegram the link or `/join <code>`; by email a first line `JOIN <code>`; in Slack `JOIN <code>`), then verify again" };
  },
  /** §6.2 ACTIVATE: the gateway runs, so messages arrive and approvals are announced (D72). */
  gateway_running: async (home) => ((await (await import("./gateway-process.js")).gatewayStatus(home)).status === "running" ? { ok: true } : { ok: false, hint: "The gateway is not running: run 'taskfollow gateway start', then 'taskfollow resume'" }),
  /** §6.2 WORKFLOWS: at least one workflow was added (D98). */
  workflows_present: async (home) => ((await (await lifecycle()).lifecycleStatus(home)).length > 0 ? { ok: true } : { ok: false, hint: "No workflow yet: run 'taskfollow workflow suggestions', then 'taskfollow workflow add <id>' for the ones the person chooses" }),
  /** §6.2 DRY RUN: every workflow's current version had a dry run that did not fail. */
  dry_runs_done: async (home) => {
    const missing = (await (await lifecycle()).lifecycleStatus(home)).filter((row) => !row.ran).map((row) => row.id);
    return missing.length === 0 ? { ok: true } : { ok: false, hint: `No dry run yet (or it failed) for: ${missing.join(", ")}: run 'taskfollow dryrun' and show the person the output` };
  },
  /** §6.2 DRY RUN: the person confirmed each dry run in their own terminal. */
  dry_runs_confirmed: async (home) => {
    const open = (await (await lifecycle()).lifecycleStatus(home)).filter((row) => !row.confirmed).map((row) => row.id);
    return open.length === 0 ? { ok: true } : { ok: false, hint: `Waiting for the person to run 'taskfollow dryrun confirm <workflow>' in their own terminal for: ${open.join(", ")}` };
  },
  /** §6.2 ACTIVATE: the OS scheduler runs the tick (the person loaded the entry 'taskfollow schedule install' printed). */
  runner_ticking: async (home) => ((await (await lifecycle()).runnerTicking(home, now())) ? { ok: true } : { ok: false, hint: "The runner has not ticked in the last five minutes: run 'taskfollow schedule install' and ask the person to run the commands it prints, then verify again" }),
};

export const KNOWN_ACTIONS: readonly string[] = Object.keys(ACTIONS);
export const KNOWN_CHECKS: readonly string[] = Object.keys(CHECKS);

export async function runAction(home: string, action: Action, state?: InstallState): Promise<StatePatch> {
  if (!Object.hasOwn(ACTIONS, action.action)) throw new InputError(`Unknown action '${action.action}'`);
  const run = ACTIONS[action.action];
  return run(home, action.args ?? {}, state);
}

export async function runCheck(home: string, check: Check, state?: InstallState): Promise<CheckResult> {
  if (!Object.hasOwn(CHECKS, check.check)) throw new InputError(`Unknown check '${check.check}'`);
  const run = CHECKS[check.check];
  return run(home, check.args ?? {}, state);
}
