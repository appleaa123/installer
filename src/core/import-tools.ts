import { InputError } from "./inputs.js";
import { checkedWrite } from "./record-tools.js";
import { findByKey, readTable, rowWith, type RecordValues, type Table } from "./records.js";
import { onlyKeys, prepareAction, requireTool, textArg, type ToolArgs, type ToolContext, type ToolDef } from "./tools.js";

/**
 * Import with a change preview (spec §9.5, D71). The agent turns the person's file into rows of field values;
 * `records.preview_import` (L0) shows what would be new, changed, unchanged or conflicting and the level the
 * import needs; `records.import` applies exactly the previewed changes once approved. Adding records is L2;
 * overwriting any existing record is a bulk overwrite, floor category `irreversible`, so L3. The current
 * values it overwrites, and the keys it adds, are its expected values (§9.6).
 */
export const MAX_IMPORT_ROWS = 500;

interface Change {
  readonly key: string;
  readonly row: number;
  readonly from: RecordValues;
  readonly to: RecordValues;
}

interface Conflict {
  readonly row: number;
  readonly key?: string;
  readonly reason: string;
}

interface ImportPlan {
  readonly created: readonly RecordValues[];
  readonly changed: readonly Change[];
  readonly unchanged: number;
  readonly conflicting: readonly Conflict[];
}

const EMPTY: ImportPlan = { created: [], changed: [], unchanged: 0, conflicting: [] };

/** One import row against the sheet: new, a change of the fields that differ, or unchanged. */
function classify(table: Table, values: Readonly<Record<string, unknown>>, key: string): ImportPlan {
  const existing = findByKey(table, key);
  if (!existing) return { ...EMPTY, created: [checkedWrite(table, values, "create")] };
  const { [table.entity.key]: _key, ...rest } = values;
  const wanted = Object.keys(rest).length === 0 ? {} : checkedWrite(table, rest, "update");
  const differing = Object.keys(wanted).filter((field) => wanted[field] !== (existing.values[field] ?? ""));
  if (differing.length === 0) return { ...EMPTY, unchanged: 1 };
  const pick = (source: RecordValues) => Object.fromEntries(differing.map((field) => [field, source[field] ?? ""]));
  return { ...EMPTY, changed: [{ key: existing.values[table.entity.key] ?? key, row: existing.row, from: pick(existing.values), to: pick(wanted) }] };
}

const merge = (a: ImportPlan, b: ImportPlan): ImportPlan => ({
  created: [...a.created, ...b.created], changed: [...a.changed, ...b.changed], unchanged: a.unchanged + b.unchanged, conflicting: [...a.conflicting, ...b.conflicting],
});

export function planImport(table: Table, rows: readonly Readonly<Record<string, unknown>>[]): ImportPlan {
  const keyField = table.entity.key;
  const keys = rows.map((values) => (typeof values[keyField] === "string" ? (values[keyField] as string).trim().toLowerCase() : ""));
  return rows.reduce<ImportPlan>((plan, values, index) => {
    const key = keys[index] ?? "";
    const conflict = (reason: string): ImportPlan => merge(plan, { ...EMPTY, conflicting: [{ row: index + 1, ...(key ? { key } : {}), reason }] });
    if (key === "") return conflict(`has no ${keyField}`);
    const first = keys.indexOf(key);
    if (first !== index) return conflict(`repeats the ${keyField} of import row ${first + 1}`);
    try {
      return merge(plan, classify(table, values, key));
    } catch (error) {
      if (error instanceof InputError) return conflict(error.message);
      throw error;
    }
  }, EMPTY);
}

function parseImport(tool: string) {
  return (args: ToolArgs): ToolArgs => {
    onlyKeys(args, ["entity", "rows"], tool);
    const rows = args.rows;
    const valid = Array.isArray(rows) && rows.every((row) => typeof row === "object" && row !== null && !Array.isArray(row));
    if (!valid || rows.length === 0 || rows.length > MAX_IMPORT_ROWS) throw new InputError(`${tool} needs 'rows': a list of 1 to ${MAX_IMPORT_ROWS} objects of field names to text`);
    return { entity: textArg(args, "entity", tool), rows };
  };
}

async function currentPlan(ctx: ToolContext, args: ToolArgs): Promise<{ table: Table; plan: ImportPlan }> {
  const table = await readTable(ctx.home, args.entity as string);
  return { table, plan: planImport(table, args.rows as Readonly<Record<string, unknown>>[]) };
}

/** What the approval binds: the keys it adds (still free) and the current values it overwrites. */
async function importExpected(ctx: ToolContext, args: ToolArgs): Promise<ToolArgs> {
  const { table, plan } = await currentPlan(ctx, args);
  if (plan.conflicting.length > 0) {
    const first = plan.conflicting[0] as Conflict;
    throw new InputError(`Fix the ${plan.conflicting.length} conflicting row(s) first (records.preview_import lists them); import row ${first.row} ${first.reason}`);
  }
  return { created: plan.created.map((values) => values[table.entity.key] ?? ""), changed: Object.fromEntries(plan.changed.map((change) => [change.key, change.from])) };
}

const ROWS = { type: "array", minItems: 1, maxItems: MAX_IMPORT_ROWS, items: { type: "object", additionalProperties: { type: "string" } } };
const ENTITY = { type: "string" };
const fieldsWritten = (args: ToolArgs) => [...new Set((args.rows as Record<string, unknown>[]).flatMap((row) => Object.keys(row)))].map((field) => ({ entity: args.entity as string, field }));

export const IMPORT_TOOLS: readonly ToolDef[] = [
  {
    name: "records.preview_import", level: "L0", fields: { entity: ENTITY, rows: ROWS }, required: ["entity", "rows"],
    description: "Show what importing these rows would do: new, changed (from → to), unchanged and conflicting rows, and the approval level the import needs.",
    parse: parseImport("records.preview_import"),
    run: async (ctx, args) => {
      const { plan } = await currentPlan(ctx, args);
      const summary = { entity: args.entity, new: plan.created, changed: plan.changed.map(({ key, from, to }) => ({ key, from, to })), unchanged: plan.unchanged, conflicting: plan.conflicting };
      if (plan.conflicting.length > 0) return { ...summary, level: null, next: "Fix or drop the conflicting rows, then preview again" };
      const prepared = await prepareAction(ctx, requireTool(ctx.registry, "records.import"), { entity: args.entity, rows: args.rows });
      return { ...summary, level: prepared.level, reasons: prepared.reasons, next: "Show this preview to the person, then call approvals.request for records.import with the same rows" };
    },
  },
  {
    name: "records.import", fields: { entity: ENTITY, rows: ROWS }, required: ["entity", "rows"],
    description: "Apply an import exactly as previewed. L2 when it only adds records; L3 (decision maker) when it overwrites any existing record.",
    parse: parseImport("records.import"), writes: fieldsWritten, expected: importExpected,
    floor: (_args, expected) => (Object.keys((expected.changed ?? {}) as object).length > 0 ? ["irreversible"] : []),
    run: async (ctx, args) => {
      const { table, plan } = await currentPlan(ctx, args);
      const updates = plan.changed.map((change) => ({ row: change.row, cells: rowWith(table, table.cells[change.row - 1] ?? [], change.to) }));
      if (updates.length > 0) await table.sheets.writeRows(table.source, updates);
      if (plan.created.length > 0) await table.sheets.appendRows(table.source, plan.created.map((values) => rowWith(table, [], values)));
      return { entity: table.entityName, created: plan.created.length, changed: plan.changed.length, unchanged: plan.unchanged };
    },
  },
];
