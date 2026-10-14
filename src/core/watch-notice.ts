import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { confinedPath } from "./actions.js";
import { appendAudit } from "./audit.js";
import { readConfig, writeConfig } from "./data-source.js";
import { loadWatch } from "./watch.js";
import { CALLS_DIR, REASON_NAME } from "./watch-record.js";

/**
 * "I noticed" (D148): once a day, for each watched service, the days of the last four weeks on which the person's
 * agent called it directly. A service used on five days or more gets one message, once, to the person who asked for
 * suggestions (`taskfollow watch suggest <name>`), pointing them at the interview: the agent with them works out what
 * the work is. Nothing is created or changed; the person decides.
 */
export const NOTICE_FILE = join("config", "watch-notice.json");
const WINDOW_DAYS = 28;
const MIN_DAYS = 5;
const DAY_MS = 86_400_000;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function serviceOf(line: Raw, services: readonly string[]): string | null {
  const tool = typeof line.tool === "string" ? line.tool : "";
  if (tool === REASON_NAME) return null;
  if (tool === "Bash") {
    const word = `cli:${String(line.what ?? "").split(" ")[0] ?? ""}`;
    return services.includes(word) ? word : null;
  }
  return services.find((service) => service.startsWith("mcp:") && tool.startsWith(`mcp__${service.slice(4)}__`)) ?? null;
}

/** Per watched service, how many of the last 28 days (today included) had at least one direct call. */
export async function habits(home: string, services: readonly string[], now: string): Promise<Record<string, number>> {
  const first = new Date(Date.parse(now) - (WINDOW_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = now.slice(0, 10);
  let names: string[];
  try {
    names = (await readdir(await confinedPath(home, CALLS_DIR))).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
  } catch {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const name of names) {
    const day = name.slice(0, 10);
    if (day < first || day > today) continue;
    const seen = new Set<string>();
    for (const row of (await readFile(join(await confinedPath(home, CALLS_DIR), name), "utf8")).split("\n")) {
      try {
        const line: unknown = JSON.parse(row);
        const service = isRecord(line) ? serviceOf(line, services) : null;
        if (service) seen.add(service);
      } catch {
        continue;
      }
    }
    for (const service of seen) counts[service] = (counts[service] ?? 0) + 1;
  }
  return counts;
}

const plainName = (service: string): string => (service.startsWith("mcp:") ? `${service.slice(4)} (through its connector)` : `the ${service.slice(4)} command`);

/** Run by the tick; returns the services it sent a suggestion about. */
export async function noticeHabits(home: string, now: () => string, notify: (member: string, text: string) => Promise<void>): Promise<string[]> {
  const watch = await loadWatch(home);
  if (!watch.suggest_to || watch.services.length === 0) return [];
  const at = now();
  const raw = await readConfig(home, NOTICE_FILE);
  const notice = isRecord(raw) ? raw : {};
  if (notice.checked === at.slice(0, 10)) return [];
  const suggested = Array.isArray(notice.suggested) ? notice.suggested.filter((entry): entry is string => typeof entry === "string") : [];
  const counts = await habits(home, watch.services, at);
  const fresh = Object.entries(counts).filter(([service, days]) => days >= MIN_DAYS && !suggested.includes(service)).map(([service]) => service);
  for (const service of fresh) {
    const days = counts[service] ?? 0;
    await notify(watch.suggest_to, `I noticed your agent used ${plainName(service)} on ${days} of the last ${WINDOW_DAYS} days. If it is the same work each time, tell your assistant what you do there: it can propose a workflow that runs by itself and asks you before anything that matters. Nothing changes unless you say so.`);
    await appendAudit(home, { ts: at, actor: "engine", event: "watch.noticed", ref: "watch", payload: { service, days, to: watch.suggest_to } });
  }
  await writeConfig(home, NOTICE_FILE, { checked: at.slice(0, 10), suggested: [...suggested, ...fresh] });
  return fresh;
}
