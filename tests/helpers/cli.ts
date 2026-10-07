import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const CLI = resolve("dist/cli.js");

export interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly json: unknown;
}

function lastJson(text: string): unknown {
  const line = text.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function runCli(args: readonly string[], options: { home?: string; cwd?: string; env?: Record<string, string> }): CliResult {
  const homeArgs = options.home === undefined ? [] : ["--home", options.home];
  const result = spawnSync(process.execPath, [CLI, ...homeArgs, ...args], {
    encoding: "utf8",
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...process.env, ...options.env },
  });
  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json: lastJson(result.stdout) ?? lastJson(result.stderr) };
}
