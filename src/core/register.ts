import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ActionFailure } from "./failure.js";
import { fillTemplate, runProcess, type ProcessResult } from "./headless.js";
import type { RuntimeProfile } from "./profile.js";

/** `claude mcp add-json` health-checks nothing, but a slow agent start is still possible. */
export const MCP_COMMAND_TIMEOUT_MS = 60_000;
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** The test suite runs from src/, so it points this at the built CLI; the package needs no override. */
export const CLI_PATH_ENV = "INSTALLER_CLI";

/** The installer's own entry file (dist/core/register.js → dist/cli.js), absolute, so the agent can run it from any folder. */
export function installerCliPath(): string {
  return realpathSync(process.env[CLI_PATH_ENV] || fileURLToPath(new URL("../cli.js", import.meta.url)));
}

/** The command the agent runs for every request's headers; absolute paths, quoted for the agent's shell (D52). */
export function headersHelperCommand(secretId: string, execPath: string, cliPath: string): string {
  return `${shellQuote(execPath)} ${shellQuote(cliPath)} mcp-headers ${secretId}`;
}

/** The `claude mcp add-json` payload: an http server whose Authorization header comes from the helper, never from a file. */
export function mcpServerConfig(url: string, headersHelper: string): string {
  return JSON.stringify({ type: "http", url, headersHelper });
}

function requireTemplate(profile: RuntimeProfile, key: "mcp_register" | "mcp_remove"): readonly string[] {
  const template = profile[key];
  if (!template) throw new ActionFailure(`The ${profile.name} profile has no ${key} template, so the installer cannot manage its MCP servers`);
  return template.cmd;
}

function mcpCommand(profile: RuntimeProfile, key: "mcp_register" | "mcp_remove", vars: Readonly<Record<string, string>>, cwd: string): Promise<ProcessResult> {
  return runProcess(fillTemplate(requireTemplate(profile, key), { profile_dir: profile.dir, ...vars }), cwd, MCP_COMMAND_TIMEOUT_MS);
}

const tail = (stdout: string): string => (stdout.trim() === "" ? "" : ` (${stdout.trim().slice(-200)})`);

/** The local tools server's name in the agent; Claude Code shows its tools as mcp__installer__<group>_<action> (D56). */
export const TOOLS_MCP_NAME = "installer";

/** The `claude mcp add-json` payload for the local tools server: a stdio command with absolute paths, no shell (D56). */
export function toolsServerConfig(execPath: string, cliPath: string, home: string): string {
  return JSON.stringify({ type: "stdio", command: execPath, args: [cliPath, "--home", home, "mcp-serve"] });
}

/**
 * Remove, then add: verified live that `claude mcp add-json` refuses an existing name and that
 * `claude mcp remove` of a missing name exits 1 with a message, so this is idempotent without `mcp get`
 * (which would health-check the server and run the headers helper).
 */
export async function registerMcpConfig(profile: RuntimeProfile, name: string, configJson: string, cwd: string): Promise<void> {
  await mcpCommand(profile, "mcp_remove", { name }, cwd);
  const result = await mcpCommand(profile, "mcp_register", { name, config_json: configJson }, cwd);
  if (result.error) throw new ActionFailure(`Could not register the '${name}' MCP server in ${profile.name}: the command ${result.error}${tail(result.stdout)}`);
}

export async function registerMcp(profile: RuntimeProfile, name: string, url: string, headersHelper: string, cwd: string): Promise<void> {
  await registerMcpConfig(profile, name, mcpServerConfig(url, headersHelper), cwd);
}

/** True when a server of that name was removed, false when there was none (or the agent is gone). */
export async function unregisterMcp(profile: RuntimeProfile, name: string, cwd: string): Promise<boolean> {
  return (await mcpCommand(profile, "mcp_remove", { name }, cwd)).code === 0;
}
