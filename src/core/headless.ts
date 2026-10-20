import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileError, type RuntimeProfile } from "./profile.js";
import { spawnable } from "./win-shim.js";

export const HEADLESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;

export interface HeadlessRequest {
  readonly prompt: string;
  readonly schema?: object;
  readonly sessionId?: string;
  /** Exactly one tool the agent may call; replaces the profile's tools-off flags for this call (C6 probe, D54). */
  readonly allowTool?: string;
  /** Judge and agent calls (D157): the agent keeps no transcript of what it was shown; the probe's resume check needs one. */
  readonly ephemeral?: boolean;
}

export type HeadlessResult =
  | { readonly ok: true; readonly text: string; readonly structured?: unknown; readonly sessionId?: string }
  | { readonly ok: false; readonly error: string };

export interface HeadlessOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

/** Fills {name} placeholders inside argv tokens. Values are inserted as-is and never rescanned. */
export function fillTemplate(argv: readonly string[], vars: Readonly<Record<string, string>>): string[] {
  return argv.map((token) =>
    token.replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
      if (!Object.hasOwn(vars, name)) throw new ProfileError(`Profile placeholder '${whole}' has no value`);
      return vars[name];
    }),
  );
}

export interface ProcessResult {
  readonly stdout: string;
  readonly code: number | null;
  readonly error?: string;
  /** Only from `runProcessWithStderr`: the end of what the command printed on stderr. */
  readonly stderr?: string;
}

const MAX_STDERR_CHARS = 4_000;

/** Spawns argv with no shell (on Windows through `spawnable`, D115); stdin gets `input` (keychain values travel that way) and is closed at once. Never rejects. */
export async function runProcess(argv: readonly string[], cwd: string, timeoutMs: number, input?: string, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  const target = await spawnable(argv);
  if ("error" in target) return { stdout: "", code: null, error: target.error };
  return spawnProcess(target.argv, cwd, timeoutMs, input, env);
}

/** `runProcess` for tools that explain their failures on stderr (pipx, Skills Wiki, D178); its end is kept in `stderr`. */
export async function runProcessWithStderr(argv: readonly string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  const target = await spawnable(argv);
  if ("error" in target) return { stdout: "", code: null, error: target.error, stderr: "" };
  return spawnProcess(target.argv, cwd, timeoutMs, undefined, env, true);
}

function spawnProcess(argv: readonly string[], cwd: string, timeoutMs: number, input?: string, env?: NodeJS.ProcessEnv, keepStderr = false): Promise<ProcessResult> {
  const [file = "", ...args] = argv;
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
    });
    const kept = (): { stderr?: string } => (keepStderr ? { stderr } : {});
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = `timed out after ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_CHARS && !failure) {
        failure = "printed too much output";
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done({ stdout, code: null, error: error.code === "ENOENT" ? `'${file}' is not installed` : error.message, ...kept() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, code, ...(failure ? { error: failure } : code === 0 ? {} : { error: `exited with code ${code}` }), ...kept() });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function pick(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), value);
}

function toolArgs(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  if (request.allowTool === undefined) return [...(profile.headless.tools_off ?? [])];
  if (!profile.headless.allow_tool) throw new ProfileError(`Profile '${profile.id}' has no headless.allow_tool template, so it cannot allow '${request.allowTool}'`);
  return fillTemplate(profile.headless.allow_tool, { tool: request.allowTool });
}

/** The headless command, or the profile's resume command when a session is resumed and the profile has one. */
function baseArgv(profile: RuntimeProfile, request: HeadlessRequest): { readonly base: string[]; readonly resume: string[] } {
  const vars = { profile_dir: profile.dir, prompt: request.prompt };
  const resume = request.sessionId ? profile.resume : undefined;
  if (resume && "cmd" in resume) return { base: fillTemplate(resume.cmd, { ...vars, session_id: request.sessionId ?? "" }), resume: [] };
  return { base: fillTemplate(profile.headless.cmd, vars), resume: resume ? fillTemplate(resume.flag, { session_id: request.sessionId ?? "" }) : [] };
}

/** Exported for tests: the exact argv a request produces; `schemaFile` fills {schema_file}. */
export function buildArgv(profile: RuntimeProfile, request: HeadlessRequest, schemaFile = ""): string[] {
  const { base, resume } = baseArgv(profile, request);
  const schema = request.schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(request.schema), schema_file: schemaFile }) : [];
  const ephemeral = request.ephemeral ? [...(profile.headless.no_persist ?? [])] : [];
  return [...base, ...toolArgs(profile, request), ...schema, ...ephemeral, ...resume];
}

/** The JSON answer: one object, or (JSON Lines) the lines that parse; null when nothing parses. */
function parseOutput(profile: RuntimeProfile, stdout: string): unknown[] | null {
  if (profile.headless.output !== "jsonl") {
    try {
      return [JSON.parse(stdout) as unknown];
    } catch {
      return null;
    }
  }
  const lines = stdout.split("\n").flatMap((line) => {
    try {
      return line.trim() === "" ? [] : [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
  return lines.length === 0 ? null : lines;
}

/** The value at `path` in the last line that has one (and, for the answer, matches `result_line`). */
function lastAt(lines: readonly unknown[], path: string, line?: { readonly path: string; readonly equals: string }): unknown {
  const matching = line ? lines.filter((value) => pick(value, line.path) === line.equals) : lines;
  return matching.map((value) => pick(value, path)).filter((value) => value !== undefined).at(-1);
}

/** A structured answer printed as text (Codex prints the schema's JSON as its message) is parsed; anything else is kept. */
function structuredFrom(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function readAnswer(profile: RuntimeProfile, request: HeadlessRequest, stdout: string): HeadlessResult {
  const lines = parseOutput(profile, stdout);
  if (lines === null) return { ok: false, error: "did not print JSON" };
  const { error_path, result_path, result_line, session_path } = profile.headless;
  if (error_path && lines.some((value) => pick(value, error_path) === true)) return { ok: false, error: "reported an error" };
  const text = lastAt(lines, result_path, result_line);
  if (typeof text !== "string") return { ok: false, error: `printed no text at '${result_path}'` };
  const sessionId = lines.map((value) => pick(value, session_path)).find((value) => typeof value === "string");
  const structured = request.schema && profile.schema ? structuredFrom(lastAt(lines, profile.schema.result_path, result_line)) : undefined;
  return { ok: true, text, ...(typeof sessionId === "string" ? { sessionId } : {}), ...(structured === undefined ? {} : { structured }) };
}

/** A profile whose schema flag names a file gets the schema in a private temporary folder, removed after the call. */
async function withSchemaFile<T>(profile: RuntimeProfile, request: HeadlessRequest, call: (file: string) => Promise<T>): Promise<T> {
  if (!request.schema || !profile.schema?.flag.some((part) => part.includes("{schema_file}"))) return call("");
  const dir = await mkdtemp(join(tmpdir(), "installer-schema-"));
  try {
    const file = join(dir, "schema.json");
    await writeFile(file, JSON.stringify(request.schema), { mode: 0o600 });
    return await call(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runHeadless(profile: RuntimeProfile, request: HeadlessRequest, options: HeadlessOptions): Promise<HeadlessResult> {
  return runProfileCommand(profile, request, (file) => buildArgv(profile, request, file), options);
}

/**
 * D178: local Skills Wiki's prompt hook stays quiet in TaskFollow's own agent calls; a judge or a task gets the
 * workflow's skills from TaskFollow, never a suggestion to load another one.
 */
export const SKILLSWIKI_HOOK_OFF = "SKILLSWIKI_HOOK_OFF";
export const agentEnv = (env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv => ({ ...(env ?? process.env), [SKILLSWIKI_HOOK_OFF]: "1" });

/** Runs a command built from the profile (the headless call, or a task step's) and reads its answer the same way. */
export async function runProfileCommand(profile: RuntimeProfile, request: HeadlessRequest, build: (schemaFile: string) => string[], options: HeadlessOptions & { readonly env?: NodeJS.ProcessEnv }): Promise<HeadlessResult> {
  const { stdout, error } = await withSchemaFile(profile, request, (file) => runProcess(build(file), options.cwd, options.timeoutMs ?? HEADLESS_TIMEOUT_MS, undefined, agentEnv(options.env)));
  if (error) return { ok: false, error };
  return readAnswer(profile, request, stdout);
}

/** The schema flag for a request, as buildArgv appends it. */
export const schemaArgs = (profile: RuntimeProfile, schema: object | undefined, schemaFile: string): string[] =>
  schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(schema), schema_file: schemaFile }) : [];
