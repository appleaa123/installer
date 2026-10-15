import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * What a call the person's agent makes directly (outside TaskFollow) to a watched service leaves behind (D146): one
 * thin line in `data/agent-calls/<day>.jsonl`. Only the tool, the first words of a command or the names of the
 * arguments, and how long it took; never values, which can be customer emails and order numbers. The agent's stated
 * reason (`actions_reason`) is kept, so `taskfollow why direct` can pair it. This file imports nothing from the engine:
 * it runs in the person's own sessions after every watched call and must start fast and never fail them.
 */
export const CALLS_DIR = join("data", "agent-calls");
export const REASON_NAME = "mcp__installer__actions_reason";
const COMMAND_WORDS = 3;
const MAX_WHY = 300;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function watchedServer(tool: string, services: readonly string[]): boolean {
  return services.some((service) => service.startsWith("mcp:") && tool.startsWith(`mcp__${service.slice(4)}__`));
}

/** The line for one call, or null when the call is not one of the watched services. */
export function thinLine(event: Raw, services: readonly string[], now: string): Raw | null {
  const tool = str(event.tool_name);
  const input = isRecord(event.tool_input) ? event.tool_input : {};
  const base = { ts: now, session: str(event.session_id), tool };
  const ms = typeof event.duration_ms === "number" ? { ms: event.duration_ms } : {};
  if (tool === REASON_NAME) return { ...base, reason_for: str(input.tool), why: str(input.why).slice(0, MAX_WHY) };
  if (tool === "Bash") {
    const words = str(input.command).trim().split(/\s+/);
    if (!services.includes(`cli:${words[0] ?? ""}`)) return null;
    return { ...base, what: words.slice(0, COMMAND_WORDS).join(" "), ...ms };
  }
  if (!watchedServer(tool, services)) return null;
  return { ...base, what: Object.keys(input).sort().join(", "), ...ms };
}

/** Records one call; any problem is swallowed, because the person's own session must never break because of this. */
export async function recordDirectCall(home: string, stdin: string, services: readonly string[], now: string): Promise<void> {
  try {
    const event: unknown = JSON.parse(stdin);
    if (!isRecord(event)) return;
    const line = thinLine(event, services, now);
    if (!line) return;
    const dir = join(home, CALLS_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, `${now.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Nothing: a watched call that could not be recorded is simply not in the record.
  }
}
