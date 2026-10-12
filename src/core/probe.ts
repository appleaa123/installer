import { randomBytes } from "node:crypto";
import { HEADLESS_TIMEOUT_MS, fillTemplate, runHeadless, runProcess, type HeadlessRequest, type HeadlessResult } from "./headless.js";
import { versionAtLeast, type RuntimeProfile } from "./profile.js";
import type { CapabilityMap } from "./types.js";

const DETECT_TIMEOUT_MS = 10_000;
const RECALL_PROMPT = "What word did I ask you to remember? Reply with the word only.";
const WORD_SCHEMA = { type: "object", properties: { word: { type: "string" } }, required: ["word"], additionalProperties: false };

export interface ProbeOptions {
  readonly profiles: readonly RuntimeProfile[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface ProbeCheck {
  readonly ok: boolean;
  readonly note?: string;
}

type Run = (request: HeadlessRequest) => Promise<HeadlessResult>;

const nonce = (): string => `w${randomBytes(4).toString("hex")}`;

function verdict(label: string, result: HeadlessResult, ok: boolean): ProbeCheck {
  if (ok) return { ok };
  return { ok, note: `${label}: ${result.ok ? "unexpected answer" : `the agent ${result.error}`}` };
}

async function checkHeadless(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const result = await run({ prompt: `Reply with exactly this word: ${word}` });
  return verdict("C4 headless", result, result.ok && result.text.includes(word));
}

async function checkSchema(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const result = await run({ prompt: `Put this word in the field word: ${word}`, schema: WORD_SCHEMA });
  const structured = result.ok ? result.structured : undefined;
  const ok = typeof structured === "object" && structured !== null && (structured as Record<string, unknown>).word === word;
  return verdict("C4 schema", result, ok);
}

async function checkResume(run: Run): Promise<ProbeCheck> {
  const word = nonce();
  const first = await run({ prompt: `Remember this word: ${word}. Reply OK.` });
  if (!first.ok || !first.sessionId) return verdict("C5 resume", first, false);
  const second = await run({ prompt: RECALL_PROMPT, sessionId: first.sessionId });
  return verdict("C5 resume", second, second.ok && second.text.includes(word) && second.sessionId === first.sessionId);
}

export async function detectAgent(profiles: readonly RuntimeProfile[], cwd: string): Promise<{ profile: RuntimeProfile; version: string | null } | null> {
  for (const profile of profiles) {
    const { stdout, error } = await runProcess(fillTemplate(profile.detect.cmd, { profile_dir: profile.dir }), cwd, DETECT_TIMEOUT_MS);
    if (error || !stdout.includes(profile.detect.match)) continue;
    return { profile, version: /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null };
  }
  return null;
}

export interface McpProbeOptions {
  readonly profile: RuntimeProfile;
  /** The agent's own working folder: MCP trust is per folder (D52, D54). */
  readonly cwd: string;
  readonly serverName: string;
  /** What the engine's own get_active_combo call returned. */
  readonly expectedSlug: string;
  readonly timeoutMs?: number;
}

export const mcpToolName = (serverName: string): string => `mcp__${serverName}__get_active_combo`;

/** C6: the agent calls the registered server's get_active_combo and must report the same slug the engine saw (fact 5). */
export async function probeMcp(options: McpProbeOptions): Promise<ProbeCheck> {
  const tool = mcpToolName(options.serverName);
  if (!options.profile.headless.allow_tool) return { ok: false, note: `C6 MCP: the ${options.profile.name} profile has no headless.allow_tool template` };
  const request: HeadlessRequest = { prompt: `Call the tool ${tool} (no arguments) and reply with only the value of its combo_slug field, nothing else.`, allowTool: tool };
  const result = await runHeadless(options.profile, request, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? HEADLESS_TIMEOUT_MS });
  if (result.ok && result.text.trim() === options.expectedSlug) return { ok: true };
  const detail = result.ok ? `the agent answered '${result.text.trim().slice(0, 80)}' instead of '${options.expectedSlug}'` : `the agent ${result.error}`;
  return { ok: false, note: `C6 MCP: ${detail}; workspace trust may be missing in ${options.cwd} (open the agent there once and accept the folder)` };
}

/** Records the C6 result and recounts the support level (C4, C5, C6). */
export function withMcpProbe(runtime: CapabilityMap, check: ProbeCheck): CapabilityMap {
  const notes = [...runtime.notes.filter((note) => !note.startsWith("C6 MCP:")), ...(check.note ? [check.note] : [])];
  return { ...runtime, c6_mcp: check.ok, notes, support_level: [runtime.c4_headless, runtime.c5_resume, check.ok].filter(Boolean).length };
}
export function unknownRuntime(note: string): CapabilityMap {
  return {
    profile: null, agent_version: null, c2_shell: true, c4_headless: false, c4_schema: false, c5_resume: false,
    c6_mcp: "not_probed", support_level: 0, tier: "unknown", notes: [note],
  };
}

/** C2 holds by construction: the probe runs from the agent's shell and the agent reads its JSON back. */
export async function runProbe(options: ProbeOptions): Promise<CapabilityMap> {
  const found = await detectAgent(options.profiles, options.cwd);
  if (!found) return unknownRuntime("No known agent was found; fallbacks will apply");
  const { profile, version } = found;
  const run: Run = (request) => runHeadless(profile, request, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? HEADLESS_TIMEOUT_MS });
  const skipped: ProbeCheck = { ok: false };
  const headless = await checkHeadless(run);
  const schema = headless.ok && profile.schema ? await checkSchema(run) : skipped;
  const resume = headless.ok && profile.resume ? await checkResume(run) : skipped;
  const versionOk = version !== null && versionAtLeast(version, profile.min_version);
  const notes = [
    ...(versionOk ? [] : [`${profile.name} ${version ?? "(unknown version)"} is older than the supported ${profile.min_version}`]),
    ...[headless, schema, resume].flatMap((check) => (check.note ? [check.note] : [])),
  ];
  return {
    profile: profile.id, agent_version: version, c2_shell: true,
    c4_headless: headless.ok, c4_schema: schema.ok, c5_resume: resume.ok, c6_mcp: "not_probed",
    support_level: [headless.ok, resume.ok].filter(Boolean).length,
    tier: headless.ok && versionOk ? "compatible" : "unknown",
    notes,
  };
}
