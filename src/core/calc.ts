import { ActionFailure } from "./failure.js";

/**
 * The `calc` step (D144): numbers in a report come from arithmetic on the data, never from a model. It counts the
 * rows of a list and, for each named field, sums, averages and finds the smallest and largest value, overall and per
 * group; with `compare` (usually last period's result, `${previous.<step>}`) it adds the change and the change in
 * percent. A number may arrive as text ("19.90", as store APIs send money); other text fails the step, naming the
 * row. Empty values are counted as missing, not as zero. Results are rounded to six decimals.
 */
export interface CalcSpec {
  readonly group_by?: string;
  readonly sum: readonly string[];
  /** An earlier result to compare with; null when there is none yet. */
  readonly compare?: unknown;
}

type Stats = Readonly<Record<string, number>>;
export interface CalcResult {
  readonly count: number;
  readonly sum: Stats;
  readonly avg: Stats;
  readonly min: Stats;
  readonly max: Stats;
  readonly missing: Stats;
}
type Grouped = CalcResult & { readonly key: string };
export type CalcOutput = CalcResult & { readonly groups?: readonly Grouped[]; readonly change?: unknown };

const NUMBER = /^-?\d+(\.\d+)?$/;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function fieldOf(row: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), row);
}

function numberAt(row: unknown, field: string, index: number): number | null {
  const value = fieldOf(row, field);
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && NUMBER.test(value.trim())) return Number(value.trim());
  throw new ActionFailure(`calc: '${field}' in row ${index + 1} is not a number (${JSON.stringify(value).slice(0, 40)})`);
}

function stats(rows: readonly { readonly row: unknown; readonly index: number }[], fields: readonly string[]): CalcResult {
  const out = { sum: {} as Record<string, number>, avg: {} as Record<string, number>, min: {} as Record<string, number>, max: {} as Record<string, number>, missing: {} as Record<string, number> };
  for (const field of fields) {
    const values = rows.map(({ row, index }) => numberAt(row, field, index));
    const present = values.filter((value): value is number => value !== null);
    const missing = values.length - present.length;
    if (missing > 0) out.missing[field] = missing;
    if (present.length === 0) continue;
    const total = present.reduce((a, b) => a + b, 0);
    out.sum[field] = round(total);
    out.avg[field] = round(total / present.length);
    out.min[field] = round(Math.min(...present));
    out.max[field] = round(Math.max(...present));
  }
  return { count: rows.length, ...out };
}

function change(now: CalcResult, before: unknown, fields: readonly string[]): unknown {
  if (!isRecord(before)) return null;
  const earlier = isRecord(before.sum) ? before.sum : {};
  const sum: Record<string, number> = {};
  const percent: Record<string, number | null> = {};
  for (const field of fields) {
    const was = earlier[field];
    const is = now.sum[field];
    if (typeof was !== "number" || is === undefined) continue;
    sum[field] = round(is - was);
    percent[field] = was === 0 ? null : Math.round(((is - was) / Math.abs(was)) * 10_000) / 100;
  }
  return { count: now.count - (typeof before.count === "number" ? before.count : 0), sum, percent };
}

export function calculate(list: unknown, spec: CalcSpec): CalcOutput {
  if (!Array.isArray(list)) throw new ActionFailure("calc: 'from' must be a list of rows");
  const rows = list.map((row, index) => ({ row, index }));
  const overall = stats(rows, spec.sum);
  const groups = spec.group_by === undefined ? undefined : groupRows(rows, spec.group_by).map(([key, members]) => ({ key, ...stats(members, spec.sum) }));
  return { ...overall, ...(groups ? { groups } : {}), ...(spec.compare === undefined ? {} : { change: change(overall, spec.compare, spec.sum) }) };
}

function groupRows(rows: readonly { readonly row: unknown; readonly index: number }[], field: string): [string, { row: unknown; index: number }[]][] {
  const groups = new Map<string, { row: unknown; index: number }[]>();
  for (const entry of rows) {
    const value = fieldOf(entry.row, field);
    const key = value === undefined || value === null ? "(none)" : String(value);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}
