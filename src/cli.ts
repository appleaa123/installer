#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { alertsCommand } from "./core/alerts.js";
import { approvalsCommand } from "./core/approval-commands.js";
import { autonomyCommand } from "./core/autonomy.js";
import { channelCommand } from "./core/channel-commands.js";
import { certify } from "./core/certify.js";
import { checkoutState, probeAgent, requireCheckout, vitestSuites } from "./core/certify-runs.js";
import { ToolRefusal } from "./core/approvals.js";
import { AuditCorruptError, appendAudit } from "./core/audit.js";
import { oauthConnectorFor } from "./core/connectors.js";
import { connectEntity, mapEntity } from "./core/data-commands.js";
import { operationsView, renderOperations } from "./core/data-flow.js";
import { disconnect } from "./core/disconnect.js";
import { guideCommand } from "./core/guide-commands.js";
import { doctorCommand } from "./core/doctor.js";
import { gatewayCommand, serveGateway } from "./core/gateway-process.js";
import { hardenCommand } from "./core/hardening.js";
import { hostCommand } from "./core/host.js";
import { listLearnings } from "./core/learning.js";
import { dryrunCommand, sandboxCommand, workflowCommand } from "./core/lifecycle.js";
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type StartExtras, type SubmitPayload } from "./core/engine.js";
import { ActionFailure } from "./core/failure.js";
import { InputError } from "./core/inputs.js";
import { inviteCommand, membersCommand } from "./core/invite-commands.js";
import { getSecret, requireSecretId, setSecret } from "./core/keychain.js";
import { buildReport, renderReport } from "./core/report.js";
import { headlessHint, launchSecretPage, openBrowser, startSecretPage } from "./core/secret-page.js";
import { startOAuthPage } from "./core/oauth-page.js";
import { pauseCommand, unpauseCommand } from "./core/pause.js";
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
import { retentionCommand } from "./core/retention.js";
import { packsCommand } from "./core/shadow.js";
import { supportBundle } from "./core/support-bundle.js";
import { uninstall } from "./core/uninstall.js";
import { installerVersion } from "./core/version.js";
import { KEY_MISSING_HINT, SKILLSWIKI_SECRET_ID, fetchSkillswikiSolution, requireSkillswikiUrl, usesSkillswiki } from "./core/skillswiki.js";
import { SolutionError, fetchHttps, loadSolutionSource } from "./core/solution.js";
import { StateCorruptError, loadState, saveState } from "./core/state.js";
import { serveStdio } from "./core/mcp-server.js";
import { ProfileError, listBundledProfiles, loadProfile } from "./core/profile.js";
import { runProbe } from "./core/probe.js";
import { modelCommand } from "./core/model.js";
import { runCommand } from "./core/run-commands.js";
import { scheduleCommand } from "./core/scheduler.js";
import { tick } from "./core/tick.js";
import { DEFAULT_TOOLS } from "./core/tool-set.js";
import { describeTools, invokeTool, toolContext } from "./core/tools.js";
import type { CapabilityMap, InstallState, Solution } from "./core/types.js";

export const EXIT = { OK: 0, INTERNAL: 1, USAGE: 2, STATE_CORRUPT: 3 } as const;
const HOME_MODE = 0o700;
const GROUP_OTHER_BITS = 0o077;
const COMMANDS = "start, next, submit, verify, resume, report, probe, secret, guide, disconnect, tool, approvals, connect, map, channel, invite, members, gateway, run, tick, schedule, model, workflow, dryrun, sandbox, harden, autonomy, alerts, learnings, doctor, pause, unpause, host, packs, retention, support, uninstall, certify, version";

class NoInstallError extends InputError {
  constructor() {
    super("No install found in this home; run 'taskpilot start --solution <ref>' first");
    this.name = "NoInstallError";
  }
}

interface Flags {
  readonly home?: string;
  readonly solution?: string;
  readonly value?: string;
  readonly done?: boolean;
  readonly json?: boolean;
  readonly profile?: string;
  readonly url?: string;
  readonly as?: string;
  readonly reason?: string;
  readonly sheet?: string;
  readonly sandbox?: boolean;
}

function emit(stream: NodeJS.WriteStream, value: unknown): void {
  stream.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

const OPTIONS = {
  home: { type: "string" }, solution: { type: "string" }, value: { type: "string" }, done: { type: "boolean" }, json: { type: "boolean" },
  profile: { type: "string" }, url: { type: "string" }, as: { type: "string" }, reason: { type: "string" }, sheet: { type: "string" },
  sandbox: { type: "boolean" },
} as const;
const OPTION_LIST = Object.keys(OPTIONS).map((name) => `--${name}`).join(", ");

/** Node's own unknown-option message suggests '--', which does not apply here. */
function unknownOption(argv: readonly string[]): string | undefined {
  const { tokens } = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS, strict: false, tokens: true });
  for (const token of tokens) {
    if (token.kind === "option" && !Object.hasOwn(OPTIONS, token.name)) return token.rawName;
  }
  return undefined;
}

function parse(argv: readonly string[]): { flags: Flags; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({ args: [...argv], allowPositionals: true, options: OPTIONS });
    return { flags: values, positionals };
  } catch (error) {
    const unknown = (error as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? unknownOption(argv) : undefined;
    throw new InputError(unknown ? `Unknown option '${unknown}'. Options: ${OPTION_LIST}` : (error as Error).message);
  }
}

function depsFor(home: string, solution: Solution): EngineDeps {
  const now = (): string => new Date().toISOString();
  return {
    home,
    solution,
    now,
    save: (state) => saveState(home, state),
    audit: async (event) => {
      const line = await appendAudit(home, { ...event, ts: now() });
      return { seq: line.seq, hash: line.hash };
    },
  };
}

async function loadInstall(home: string): Promise<{ state: InstallState; deps: EngineDeps }> {
  const state = await loadState(home);
  if (!state) throw new NoInstallError();
  const { solution } = await loadPinnedSolution(home);
  if (solution.id !== state.solution.id || solution.version !== state.solution.version) {
    throw new EngineError(`The pinned solution is ${solution.id}@${solution.version}; this install uses ${state.solution.id}@${state.solution.version}`);
  }
  return { state, deps: depsFor(home, solution) };
}

function submitPayload(flags: Flags): SubmitPayload {
  if (flags.done && flags.value !== undefined) throw new InputError("Use either --value or --done, not both");
  if (flags.done) return { kind: "done" };
  if (flags.value === undefined) throw new InputError("submit needs --value <json> or --done");
  try {
    return { kind: "value", value: JSON.parse(flags.value) as unknown };
  } catch {
    throw new InputError(`--value must be JSON, for text use quotes: --value '"yes"'`);
  }
}

function requireArg(arg: string | undefined, command: string): string {
  if (!arg) throw new InputError(`${command} needs a step id`);
  return arg;
}

function requireEntityArg(arg: string | undefined, command: string): string {
  if (!arg) throw new InputError(`${command} needs the name of an entity of the data contract, for example: taskpilot ${command} contact`);
  return arg;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function requireSameContent(home: string, existing: InstallState, text: string): Promise<void> {
  const pinned = await loadPinnedSolution(home);
  if (sha256(pinned.text) !== sha256(text)) {
    throw new EngineError(`This home already has an install of '${existing.solution.id}@${existing.solution.version}' with different solution content; use a different --home`);
  }
}

/** D34: never loosen or silently change a folder the engine did not create; refuse it instead. */
async function requirePrivateHome(home: string): Promise<void> {
  if (process.platform === "win32") return;
  const mode = (await stat(home)).mode & 0o777;
  if (mode & GROUP_OTHER_BITS) {
    throw new InputError(`${home} can be opened by other users (mode ${mode.toString(8)}); run 'chmod 700 ${home}' or use a different --home`);
  }
}

/** A `skillswiki:` ref needs the stored key and the URL before anything is fetched or created (D46). */
async function solutionSource(ref: string, flags: Flags): Promise<{ solution: Solution; text: string }> {
  if (!ref.startsWith("skillswiki:")) return loadSolutionSource(ref);
  const key = await getSecret(SKILLSWIKI_SECRET_ID);
  if (!key) throw new InputError(KEY_MISSING_HINT);
  const url = requireSkillswikiUrl(flags.url);
  return loadSolutionSource(ref, fetchHttps, (target) => fetchSkillswikiSolution({ url, key }, target));
}

function requireSameUrl(existing: InstallState, url: string | undefined): void {
  if (url !== undefined && existing.skillswiki?.url !== url) {
    throw new EngineError(`This home already has an install started ${existing.skillswiki ? `with the Skills Wiki URL '${existing.skillswiki.url}'` : "without a Skills Wiki URL"}; use a different --home`);
  }
}

async function startCommand(home: string, flags: Flags): Promise<unknown> {
  if (!flags.solution) throw new InputError("start needs --solution <ref>");
  const ref = flags.solution.startsWith("file:") ? `file:${resolve(flags.solution.slice("file:".length))}` : flags.solution;
  const { solution, text } = await solutionSource(ref, flags);
  const url = flags.url === undefined && !usesSkillswiki(solution) ? undefined : requireSkillswikiUrl(flags.url);
  const created = await mkdir(home, { recursive: true, mode: HOME_MODE });
  if (created !== undefined) await chmod(home, HOME_MODE);
  else await requirePrivateHome(home);
  const existing = await loadState(home);
  if (existing) {
    await requireSameContent(home, existing, text);
    requireSameUrl(existing, url);
  } else {
    await writePinnedSolution(home, text);
  }
  const extras: StartExtras = { work_dir: process.cwd(), ...(url ? { skillswiki: { url } } : {}) };
  return (await start(depsFor(home, solution), existing, ref, sha256(text), extras)).result;
}

/** Runs the probe in a throwaway folder; it reads no install and writes no state. */
async function probeCommand(flags: Flags): Promise<CapabilityMap> {
  const cwd = await mkdtemp(join(tmpdir(), "installer-probe-"));
  try {
    const profiles = flags.profile ? [await loadProfile(flags.profile)] : await listBundledProfiles();
    return await runProbe({ profiles, cwd });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** `taskpilot certify --profile <id>` (D116): from a source checkout; the suites and the probe run for real, the record goes under the home. */
async function certifyCommand(home: string, flags: Flags): Promise<unknown> {
  const root = await requireCheckout();
  const deps = {
    runSuite: vitestSuites(root, process.env), probe: probeAgent, checkout: () => checkoutState(root), version: await installerVersion(),
    env: process.env, platform: `${process.platform} ${process.arch}`, now: () => new Date().toISOString(),
  };
  return certify(home, flags.profile, deps);
}

/** `taskpilot secret <id>`: starts the page detached, opens the browser, returns at once (D47). */
async function secretCommand(id: string): Promise<unknown> {
  const { url, pid } = await launchSecretPage(requireSecretId(id));
  const hint = headlessHint(url);
  if (!hint) openBrowser(url);
  return { status: "waiting", url, pid, ...(hint ? { hint } : {}) };
}

/** The detached page process: serves the form (an OAuth sign-in for a connector's secret, D66), writes the keychain once, then exits. Never touches the engine home. */
async function secretServeCommand(id: string): Promise<number> {
  const store = (value: string): Promise<void> => setSecret(id, value);
  const def = await oauthConnectorFor(requireSecretId(id));
  const page = def ? await startOAuthPage({ def, store }) : await startSecretPage({ id, store });
  if (process.send) {
    process.send({ url: page.url });
    process.disconnect();
  } else {
    emit(process.stdout, { url: page.url });
  }
  await page.done;
  return EXIT.OK;
}

/** Run by the agent for every Skills Wiki request (D52): the header line, or exit 1 and no output when the key is missing. */
async function headersCommand(id: string): Promise<number> {
  const key = await getSecret(requireSecretId(id));
  if (key === null) return EXIT.INTERNAL;
  emit(process.stdout, JSON.stringify({ Authorization: `Bearer ${key}` }));
  return EXIT.OK;
}

/** `taskpilot tool <name> '<json>'`: the C6 fallback, through the same gate as the MCP server (§7.4). */
async function toolCommand(home: string, name: string | undefined, json: string | undefined): Promise<unknown> {
  if (!name) throw new InputError(`tool needs a tool name and its arguments as JSON, for example: taskpilot tool memo.list '{}'`);
  let args: unknown = {};
  if (json !== undefined) {
    try {
      args = JSON.parse(json);
    } catch {
      throw new InputError(`The arguments of '${name}' must be JSON, for example '{"id":1}'`);
    }
  }
  return invokeTool(await toolContext(home, "cli", DEFAULT_TOOLS), name, args);
}

/** Run by the agent's MCP client (D56): JSON-RPC on stdin/stdout and nothing else on stdout; each call reads the install afresh. */
async function mcpServeCommand(home: string): Promise<number> {
  const call = async (name: string, args: unknown) => {
    if (!(await loadState(home))) throw new NoInstallError();
    return invokeTool(await toolContext(home, "mcp", DEFAULT_TOOLS), name, args);
  };
  await serveStdio({ list: () => describeTools(DEFAULT_TOOLS), call }, process.stdin, process.stdout);
  return EXIT.OK;
}
/** Who runs a command that only a person may run: a terminal on stdin (an agent's shell has none, D61), and `--as`. */
const person = (flags: Flags): { interactive: boolean; as?: string } => ({ interactive: process.stdin.isTTY === true, ...(flags.as ? { as: flags.as } : {}) });

type Standalone = (home: string, flags: Flags, arg: string | undefined) => Promise<unknown>;
type OnInstall = (install: { state: InstallState; deps: EngineDeps }, flags: Flags, arg: string | undefined, extra: string | undefined) => Promise<unknown>;

/** Commands that need no install state. */
const STANDALONE: Readonly<Record<string, Standalone>> = {
  start: (home, flags) => startCommand(home, flags),
  probe: (_home, flags) => probeCommand(flags),
  secret: (_home, _flags, arg) => secretCommand(requireArg(arg, "secret")),
  /** Live setup guides (4.3): the connector's setup block for the agent to walk the person through; read-only. */
  guide: (_home, _flags, arg) => guideCommand(arg),
  disconnect: (home, _flags, arg) => disconnect(home, requireArg(arg, "disconnect"), () => new Date().toISOString()),
  /** D103: reads the state itself, so a damaged state is a finding, not an exit 3. */
  doctor: (home) => doctorCommand(home, () => new Date().toISOString()),
  certify: (home, flags) => certifyCommand(home, flags),
  /** D119: which build this is, for a support request or a certification record. */
  version: async () => ({ installer: await installerVersion(), node: process.version }),
};

/** Commands that run on the install in the home. */
const ON_INSTALL: Readonly<Record<string, OnInstall>> = {
  next: async ({ state, deps }) => (await advance(deps, state)).result,
  submit: async ({ state, deps }, flags, arg) => (await submit(deps, state, requireArg(arg, "submit"), submitPayload(flags))).result,
  verify: async ({ state, deps }, _flags, arg) => {
    const verified = await verifyStep(deps, state, requireArg(arg, "verify"));
    return { ...verified.result, next: verified.next };
  },
  resume: async ({ state, deps }) => (await resume(deps, state)).result,
  report: async ({ state, deps }, flags) => {
    const report = buildReport(deps.solution, state);
    const operations = await operationsView(deps.home, state);
    return flags.json ? { ...report, operations } : [renderReport(report), ...renderOperations(operations)].join("\n");
  },
  tool: async ({ deps }, _flags, arg, extra) => toolCommand(deps.home, arg, extra),
  approvals: async ({ state, deps }, flags, arg, extra) =>
    approvalsCommand(deps.home, state.roles, { sub: arg, id: extra, as: flags.as, reason: flags.reason, value: flags.value, interactive: process.stdin.isTTY === true }, deps.now),
  connect: async ({ deps }, flags, arg) => connectEntity(deps.home, requireEntityArg(arg, "connect"), flags.sheet, deps.now),
  map: async ({ deps }, flags, arg) => mapEntity(deps.home, requireEntityArg(arg, "map"), flags.value, deps.now, process.env, process.stdin.isTTY === true),
  channel: async ({ deps }, flags, arg) => channelCommand(deps.home, arg, flags.value, deps.now, process.env, process.stdin.isTTY === true),
  invite: async ({ state, deps }, _flags, arg) => inviteCommand(deps.home, state.roles, arg, process.stdin.isTTY === true, deps.now),
  members: async ({ deps }, _flags, arg, extra) => membersCommand(deps.home, { sub: arg, id: extra, interactive: process.stdin.isTTY === true }, deps.now),
  gateway: async ({ deps }, _flags, arg) => gatewayCommand(deps.home, arg, deps.now),
  run: async ({ deps }, flags, arg) => runCommand(deps.home, arg, flags.sandbox === true, deps.now),
  tick: async ({ deps }) => tick(deps.home, deps.now),
  schedule: async ({ deps }, flags, arg) => scheduleCommand(deps.home, arg, flags.value, deps.now),
  model: async ({ deps }, flags) => modelCommand(deps.home, flags.value, deps.now, process.stdin.isTTY === true),
  workflow: async ({ deps }, flags, arg, extra) => workflowCommand(deps.home, arg, extra, flags.value, deps.now),
  dryrun: async ({ deps }, flags, arg, extra) => dryrunCommand(deps.home, arg, extra, person(flags), deps.now, flags.value),
  sandbox: async ({ deps }, flags, arg) => sandboxCommand(deps.home, arg, person(flags), deps.now),
  harden: async ({ deps }, flags, arg, extra) => hardenCommand(deps.home, arg, extra, flags.value, person(flags), deps.now),
  autonomy: async ({ state, deps }, flags, arg, extra) => autonomyCommand(deps.home, state.roles, { sub: arg, arg: extra, as: flags.as, reason: flags.reason, interactive: process.stdin.isTTY === true }, deps.now),
  alerts: async ({ deps }, flags, arg, extra) => alertsCommand(deps.home, arg, extra, person(flags), deps.now),
  learnings: async ({ deps }) => ({ learnings: await listLearnings(deps.home) }),
  pause: async ({ deps }, flags, arg) => pauseCommand(deps.home, arg, person(flags), flags.reason, deps.now),
  unpause: async ({ deps }, flags) => unpauseCommand(deps.home, person(flags), deps.now),
  host: async ({ deps }, _flags, arg, extra) => hostCommand(deps.home, arg, extra, deps.now),
  packs: async ({ state, deps }, flags, arg, extra) => packsCommand(deps.home, arg, extra, state.roles, person(flags), deps.now),
  retention: async ({ deps }, flags) => retentionCommand(deps.home, flags.value, person(flags), deps.now),
  support: async ({ deps }, _flags, arg) => {
    if (arg !== "bundle") throw new InputError("support takes: bundle");
    return supportBundle(deps.home, deps.now);
  },
  uninstall: async ({ deps }, flags) => uninstall(deps.home, person(flags), deps.now),
};

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parse(argv);
  const home = resolve(flags.home || process.env.INSTALLER_HOME || join(homedir(), ".installer"));
  const [command = "", arg, extra] = positionals;
  if (command === "secret-serve") return secretServeCommand(requireArg(arg, command));
  if (command === "mcp-headers") return headersCommand(requireArg(arg, command));
  if (command === "mcp-serve") return mcpServeCommand(home);
  if (command === "gateway-serve") return serveGateway(home);
  if (Object.hasOwn(STANDALONE, command)) {
    emit(process.stdout, await STANDALONE[command](home, flags, arg));
    return EXIT.OK;
  }
  if (!Object.hasOwn(ON_INSTALL, command)) throw new InputError(`Unknown command '${command}'. Commands: ${COMMANDS}`);
  emit(process.stdout, await ON_INSTALL[command](await loadInstall(home), flags, arg, extra));
  return EXIT.OK;
}

function exitCodeFor(error: unknown): number {
  if (error instanceof StateCorruptError || error instanceof AuditCorruptError) return EXIT.STATE_CORRUPT;
  if (error instanceof InputError || error instanceof EngineError || error instanceof SolutionError || error instanceof NoInstallError) return EXIT.USAGE;
  if (error instanceof ProfileError || error instanceof ActionFailure || error instanceof ToolRefusal) return EXIT.USAGE;
  return EXIT.INTERNAL;
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const code = exitCodeFor(error);
    const message = error instanceof Error ? error.message : String(error);
    emit(process.stderr, { error: code === EXIT.INTERNAL ? `Internal error: ${message}` : message, code });
    process.exitCode = code;
  });
