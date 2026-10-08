import { spawn } from "node:child_process";
import { ProfileError, type RuntimeProfile } from "./profile.js";

export const HEADLESS_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;

export interface HeadlessRequest {
  readonly prompt: string;
  readonly schema?: object;
  readonly sessionId?: string;
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
}

/** Spawns argv with no shell; stdin gets `input` (keychain values travel that way) and is closed at once. Never rejects. */
export function runProcess(argv: readonly string[], cwd: string, timeoutMs: number, input?: string): Promise<ProcessResult> {
  const [file, ...args] = argv;
  return new Promise((done) => {
    const child = spawn(file, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
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
      done({ stdout, code: null, error: error.code === "ENOENT" ? `'${file}' is not installed` : error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, code, ...(failure ? { error: failure } : code === 0 ? {} : { error: `exited with code ${code}` }) });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function pick(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (typeof node === "object" && node !== null ? (node as Record<string, unknown>)[key] : undefined), value);
}

function buildArgv(profile: RuntimeProfile, request: HeadlessRequest): string[] {
  const base = fillTemplate(profile.headless.cmd, { profile_dir: profile.dir, prompt: request.prompt });
  const schema = request.schema && profile.schema ? fillTemplate(profile.schema.flag, { schema_json: JSON.stringify(request.schema) }) : [];
  const resume = request.sessionId && profile.resume ? fillTemplate(profile.resume.flag, { session_id: request.sessionId }) : [];
  return [...base, ...schema, ...resume];
}

export async function runHeadless(profile: RuntimeProfile, request: HeadlessRequest, options: HeadlessOptions): Promise<HeadlessResult> {
  const { stdout, error } = await runProcess(buildArgv(profile, request), options.cwd, options.timeoutMs ?? HEADLESS_TIMEOUT_MS);
  if (error) return { ok: false, error };
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "did not print JSON" };
  }
  if (profile.headless.error_path && pick(json, profile.headless.error_path) === true) return { ok: false, error: "reported an error" };
  const text = pick(json, profile.headless.result_path);
  if (typeof text !== "string") return { ok: false, error: `printed no text at '${profile.headless.result_path}'` };
  const sessionId = pick(json, profile.headless.session_path);
  const structured = request.schema && profile.schema ? pick(json, profile.schema.result_path) : undefined;
  return { ok: true, text, ...(typeof sessionId === "string" ? { sessionId } : {}), ...(structured === undefined ? {} : { structured }) };
}
