import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve("dist/cli.js");
/** Prefix of the throwaway working folders; global-setup removes them after the run. */
export const CLI_CWD_PREFIX = "installer-cwd-";

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

export function runCli(args: readonly string[], options: { home?: string; cwd?: string; env?: Record<string, string>; input?: string }): CliResult {
  const homeArgs = options.home === undefined ? [] : ["--home", options.home];
  const result = spawnSync(process.execPath, [CLI, ...homeArgs, ...args], {
    encoding: "utf8",
    ...(options.input === undefined ? {} : { input: options.input }),
    // A fresh folder unless the test names one: `start` records its working folder as the install folder, and
    // `workflow add` writes skill folders and CLAUDE.md there, so it must never be the repo (9.12 item 2).
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), CLI_CWD_PREFIX)),
    env: { ...process.env, ...options.env },
  });
  return { code: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, json: lastJson(result.stdout) ?? lastJson(result.stderr) };
}
