#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmod, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AuditCorruptError, appendAudit } from "./core/audit.js";
import { EngineError, advance, resume, start, submit, verifyStep, type EngineDeps, type SubmitPayload } from "./core/engine.js";
import { InputError } from "./core/inputs.js";
import { buildReport, renderReport } from "./core/report.js";
import { loadPinnedSolution, writePinnedSolution } from "./core/pin.js";
import { SolutionError, loadSolutionSource } from "./core/solution.js";
import { StateCorruptError, loadState, saveState } from "./core/state.js";
import type { InstallState, Solution } from "./core/types.js";

export const EXIT = { OK: 0, INTERNAL: 1, USAGE: 2, STATE_CORRUPT: 3 } as const;
const HOME_MODE = 0o700;
const GROUP_OTHER_BITS = 0o077;
const COMMANDS = "start, next, submit, verify, resume, report";

class NoInstallError extends Error {
  constructor() {
    super("No install found in this home; run 'installer start --solution <ref>' first");
    this.name = "NoInstallError";
  }
}

interface Flags {
  readonly home?: string;
  readonly solution?: string;
  readonly value?: string;
  readonly done?: boolean;
  readonly json?: boolean;
}

function emit(stream: NodeJS.WriteStream, value: unknown): void {
  stream.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}

const OPTIONS = { home: { type: "string" }, solution: { type: "string" }, value: { type: "string" }, done: { type: "boolean" }, json: { type: "boolean" } } as const;
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

async function startCommand(home: string, flags: Flags): Promise<unknown> {
  if (!flags.solution) throw new InputError("start needs --solution <ref>");
  const ref = flags.solution.startsWith("file:") ? `file:${resolve(flags.solution.slice("file:".length))}` : flags.solution;
  const { solution, text } = await loadSolutionSource(ref);
  const created = await mkdir(home, { recursive: true, mode: HOME_MODE });
  if (created !== undefined) await chmod(home, HOME_MODE);
  else await requirePrivateHome(home);
  const existing = await loadState(home);
  if (existing) await requireSameContent(home, existing, text);
  else await writePinnedSolution(home, text);
  return (await start(depsFor(home, solution), existing, ref)).result;
}

async function run(argv: readonly string[]): Promise<number> {
  const { flags, positionals } = parse(argv);
  const home = resolve(flags.home || process.env.INSTALLER_HOME || join(homedir(), ".installer"));
  const [command, arg] = positionals;
  if (command === "start") {
    emit(process.stdout, await startCommand(home, flags));
    return EXIT.OK;
  }
  if (!command || !["next", "submit", "verify", "resume", "report"].includes(command)) {
    throw new InputError(`Unknown command '${command ?? ""}'. Commands: ${COMMANDS}`);
  }
  const { state, deps } = await loadInstall(home);
  if (command === "next") emit(process.stdout, (await advance(deps, state)).result);
  if (command === "submit") emit(process.stdout, (await submit(deps, state, requireArg(arg, command), submitPayload(flags))).result);
  if (command === "verify") {
    const verified = await verifyStep(deps, state, requireArg(arg, command));
    emit(process.stdout, { ...verified.result, next: verified.next });
  }
  if (command === "resume") emit(process.stdout, (await resume(deps, state)).result);
  if (command === "report") {
    const report = buildReport(deps.solution, state);
    emit(process.stdout, flags.json ? report : renderReport(report));
  }
  return EXIT.OK;
}

function exitCodeFor(error: unknown): number {
  if (error instanceof StateCorruptError || error instanceof AuditCorruptError) return EXIT.STATE_CORRUPT;
  if (error instanceof InputError || error instanceof EngineError || error instanceof SolutionError || error instanceof NoInstallError) return EXIT.USAGE;
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
