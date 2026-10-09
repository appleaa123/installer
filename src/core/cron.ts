import { InputError, isValidCron } from "./inputs.js";

/**
 * Cron times in a named time zone (spec §10.3). The OS scheduler only wakes the runner once a minute (D82); the
 * runner itself works out which scheduled times fell due, in the workflow's own zone, by stepping through UTC
 * minutes and reading each one's local wall clock with Intl. So a host in another zone, a daylight-saving change
 * or a scheduler that fires late or not at all never shifts or repeats a run. Five fields as in crontab(5):
 * minute, hour, day of month, month, day of week (0 or 7 = Sunday); when both day fields are restricted, either
 * one matching is enough.
 */
export const MINUTE_MS = 60_000;
/** The longest window the runner looks back over (a host off for longer gets one notice, D84). */
export const MAX_WINDOW_MS = 31 * 24 * 60 * MINUTE_MS;
const RANGES: readonly (readonly [number, number])[] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface LocalTime {
  readonly minute: number;
  readonly hour: number;
  readonly day: number;
  readonly month: number;
  readonly weekday: number;
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(tz: string): Intl.DateTimeFormat {
  const known = formats.get(tz);
  if (known) return known;
  const made = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  formats.set(tz, made);
  return made;
}

/** The wall clock in `tz` at an instant. */
export function localTime(at: Date, tz: string): LocalTime {
  const parts = Object.fromEntries(formatFor(tz).formatToParts(at).map((part) => [part.type, part.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday: WEEKDAYS.indexOf(parts.weekday ?? "") };
}

function expand(field: string, [min, max]: readonly [number, number]): ReadonlySet<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [base = "*", step = "1"] = part.split("/");
    const [low, high] = base === "*" ? [min, max] : base.includes("-") ? base.split("-").map(Number) : [Number(base), step === "1" ? Number(base) : max];
    for (let value = low ?? min; value <= (high ?? max); value += Number(step)) values.add(value);
  }
  return values;
}

export interface CronSpec {
  readonly fields: readonly ReadonlySet<number>[];
  readonly dayOfMonthAny: boolean;
  readonly dayOfWeekAny: boolean;
}

export function parseCron(expr: string): CronSpec {
  if (!isValidCron(expr)) throw new InputError(`'${expr}' is not a 5-field cron expression (minute hour day month weekday)`);
  const parts = expr.trim().split(/\s+/);
  const fields = parts.map((part, index) => expand(part, RANGES[index] ?? [0, 0]));
  const weekdays = new Set([...(fields[4] ?? [])].map((day) => day % 7));
  return { fields: [...fields.slice(0, 4), weekdays], dayOfMonthAny: (parts[2] ?? "").startsWith("*"), dayOfWeekAny: (parts[4] ?? "").startsWith("*") };
}

export function cronMatches(spec: CronSpec, time: LocalTime): boolean {
  const [minutes, hours, days, months, weekdays] = spec.fields;
  if (!minutes?.has(time.minute) || !hours?.has(time.hour) || !months?.has(time.month)) return false;
  const dayOk = days?.has(time.day) ?? false;
  const weekdayOk = weekdays?.has(time.weekday) ?? false;
  if (!spec.dayOfMonthAny && !spec.dayOfWeekAny) return dayOk || weekdayOk;
  return dayOk && weekdayOk;
}

const minuteFloor = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** The scheduled times after `after` up to and including `until` (ISO strings, UTC minutes), oldest first. */
export function cronTimes(expr: string, tz: string, after: string, until: string): string[] {
  const spec = parseCron(expr);
  const end = minuteFloor(Date.parse(until));
  const start = Math.max(minuteFloor(Date.parse(after)) + MINUTE_MS, end - MAX_WINDOW_MS);
  const times: string[] = [];
  for (let at = start; at <= end; at += MINUTE_MS) {
    if (cronMatches(spec, localTime(new Date(at), tz))) times.push(new Date(at).toISOString());
  }
  return times;
}

/** The next scheduled time after `after`, within eight days, or null. */
export function nextCronTime(expr: string, tz: string, after: string): string | null {
  const until = new Date(Date.parse(after) + 8 * 24 * 60 * MINUTE_MS).toISOString();
  const spec = parseCron(expr);
  for (let at = minuteFloor(Date.parse(after)) + MINUTE_MS; at <= Date.parse(until); at += MINUTE_MS) {
    if (cronMatches(spec, localTime(new Date(at), tz))) return new Date(at).toISOString();
  }
  return null;
}

/** "Tue 08:00" in `tz`, for messages. */
export function wallClock(iso: string, tz: string): string {
  const time = localTime(new Date(iso), tz);
  return `${WEEKDAYS[time.weekday]} ${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
}
