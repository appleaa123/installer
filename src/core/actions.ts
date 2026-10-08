import { access, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative as relativePath, resolve, sep } from "node:path";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import { getSecret } from "./keychain.js";
import { deriveModeAction } from "./mode.js";
import { listBundledProfiles, loadProfileById, type RuntimeProfile } from "./profile.js";
import { probeMcp, runProbe, withMcpProbe } from "./probe.js";
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
const NO_AGENT_HINT = "The probe found no known agent to register Skills Wiki in; install a supported agent, then run 'installer resume'";
const NO_AGENT_TOOLS_HINT = "The probe found no known agent to connect the installer's tools to; install a supported agent, then run 'installer resume', or use 'installer tool' instead";
const NO_COMBO_HINT = "No combo is active in Skills Wiki yet: activate one in your dashboard, then run 'installer resume'";

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
  /** D56: the agent reaches the installer's own tools over MCP, as `installer --home <home> mcp-serve`. */
  register_tools_mcp: async (home, _args, state) => {
    const { profile } = await probedRuntime(state, NO_AGENT_TOOLS_HINT);
    await registerMcpConfig(profile, TOOLS_MCP_NAME, toolsServerConfig(process.execPath, installerCliPath(), resolve(home)), await probeDir(home));
    return {};
  },
  /** C6 (D54): runs in the agent's own folder, allowing exactly the registered server's get_active_combo tool. */
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
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : `No '${id}' key is stored yet: run 'installer secret ${id}', enter it on the page that opens, then run the verify again` };
  },
  /** D37: the person activates the combo in the Skills Wiki dashboard; the engine asks get_active_combo itself. */
  combo_active: async (_home, args, state) => {
    if (await activeComboSlug(await skillswikiTarget(state?.skillswiki?.url))) return { ok: true };
    return { ok: false, hint: typeof args.hint === "string" ? args.hint : "No combo is active yet: activate one in your Skills Wiki dashboard, then run the verify again" };
  },
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
