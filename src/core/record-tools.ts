import { checkValues } from "./contract.js";
import { InputError } from "./inputs.js";
import { findByKey, readTable, requireRecord, rowWith, type RecordValues, type Table } from "./records.js";
import { onlyKeys, textArg, type ToolArgs, type ToolContext, type ToolDef } from "./tools.js";

/**
 * `records.*` (spec §9.5) over the connected sheet. Reads are L0. Writes declare no level, so they are L2, and a
 * write of a `financial` or `protected_ground` field is L3 (tags from the contract, §9.3). Propose = approvals.request,
 * apply = the same call with its token (D70). The values a write depends on are its expected values (§9.6): read
 * live when the approval is asked and again when the token is used, so a record changed in between is refused.
 */
const ENTITY = { type: "string", description: "Entity name from the data contract, for example contact" };
const VALUES = { type: "object", additionalProperties: { type: "string" }, description: "Field name → text value" };
const KEY = { type: "string", description: "The record's key value" };
const MAX_FIND = 100;
const DEFAULT_FIND = 20;

function textMap(args: ToolArgs, key: string, tool: string): Readonly<Record<string, unknown>> {
  const value = args[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InputError(`${tool} needs '${key}' as an object of field names to text`);
  return value as Record<string, unknown>;
}

function parseFind(args: ToolArgs): ToolArgs {
  onlyKeys(args, ["entity", "where", "limit"], "records.find");
  const limit = args.limit ?? DEFAULT_FIND;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > MAX_FIND) throw new InputError(`records.find: 'limit' must be a whole number from 1 to ${MAX_FIND}`);
  return { entity: textArg(args, "entity", "records.find"), where: args.where === undefined ? {} : textMap(args, "where", "records.find"), limit };
}

/** Exact, case-insensitive match on every field named in `where`. */
function matches(table: Table, where: Readonly<Record<string, unknown>>): RecordValues[] {
  for (const field of Object.keys(where)) {
    if (!Object.hasOwn(table.columns, field)) throw new InputError(`records.find: '${field}' is not a mapped field of ${table.entityName}; fields: ${Object.keys(table.columns).join(", ")}`);
  }
  const wanted = Object.entries(where).map(([field, value]) => [field, String(value).trim().toLowerCase()] as const);
  return table.records.filter((record) => wanted.every(([field, value]) => (record.values[field] ?? "").toLowerCase() === value)).map((record) => record.values);
}

/** Values checked against the contract and the mapping: every field written must have a column. */
export function checkedWrite(table: Table, values: unknown, mode: "create" | "update"): RecordValues {
  const checked = checkValues(table.entityName, table.entity, values, mode);
  const unmapped = Object.keys(checked).find((field) => !Object.hasOwn(table.columns, field));
  if (unmapped !== undefined) throw new InputError(`${table.entityName}.${unmapped} has no column in the sheet: map it with 'taskfollow map ${table.entityName}' first`);
  return checked;
}

const writesOf = (args: ToolArgs) => Object.keys(textMap(args, "values", "records")).map((field) => ({ entity: args.entity as string, field }));

function parseWrite(tool: string, withKey: boolean) {
  return (args: ToolArgs): ToolArgs => {
    onlyKeys(args, withKey ? ["entity", "key", "values"] : ["entity", "values"], tool);
    return { entity: textArg(args, "entity", tool), ...(withKey ? { key: textArg(args, "key", tool) } : {}), values: textMap(args, "values", tool) };
  };
}

/** Create depends on the key still being free (§9.6). */
async function createExpected(ctx: ToolContext, args: ToolArgs): Promise<ToolArgs> {
  const table = await readTable(ctx.home, args.entity as string);
  const values = checkedWrite(table, args.values, "create");
  const key = values[table.entity.key] ?? "";
  if (findByKey(table, key)) throw new InputError(`${table.entityName} '${key}' already exists: use records.update`);
  return { key, exists: false };
}

/** Update depends on the current value of every field it changes (§9.6). */
async function updateExpected(ctx: ToolContext, args: ToolArgs): Promise<ToolArgs> {
  const table = await readTable(ctx.home, args.entity as string);
  const values = checkedWrite(table, args.values, "update");
  const current = requireRecord(table, args.key as string).values;
  return { current: Object.fromEntries(Object.keys(values).map((field) => [field, current[field] ?? ""])) };
}

export const RECORD_TOOLS: readonly ToolDef[] = [
  {
    name: "records.find", description: "Find records of an entity in the connected sheet; optional exact matches on fields (case-insensitive).", level: "L0",
    fields: { entity: ENTITY, where: VALUES, limit: { type: "integer", minimum: 1, maximum: MAX_FIND } }, required: ["entity"],
    parse: parseFind,
    run: async (ctx, args) => {
      const found = matches(await readTable(ctx.home, args.entity as string), args.where as Record<string, unknown>);
      return { entity: args.entity, records: found.slice(0, args.limit as number), total: found.length };
    },
  },
  {
    name: "records.get", description: "Get one record by its key.", level: "L0", fields: { entity: ENTITY, key: KEY }, required: ["entity", "key"],
    parse: (args) => {
      onlyKeys(args, ["entity", "key"], "records.get");
      return { entity: textArg(args, "entity", "records.get"), key: textArg(args, "key", "records.get") };
    },
    run: async (ctx, args) => ({ entity: args.entity, record: requireRecord(await readTable(ctx.home, args.entity as string), args.key as string).values }),
  },
  {
    name: "records.create", description: "Add a record. A person approves it first (L2; L3 when it writes a financial or protected field).",
    fields: { entity: ENTITY, values: VALUES }, required: ["entity", "values"],
    parse: parseWrite("records.create", false), writes: writesOf, expected: createExpected,
    run: async (ctx, args) => {
      const table = await readTable(ctx.home, args.entity as string);
      const values = checkedWrite(table, args.values, "create");
      if (findByKey(table, values[table.entity.key] ?? "")) throw new InputError(`${table.entityName} '${values[table.entity.key]}' already exists: use records.update`);
      await table.sheets.appendRow(table.source, rowWith(table, [], values));
      return { entity: table.entityName, created: values };
    },
  },
  {
    name: "records.update", description: "Change fields of one record. A person approves the exact change first; it is refused if the record changed since.",
    fields: { entity: ENTITY, key: KEY, values: VALUES }, required: ["entity", "key", "values"],
    parse: parseWrite("records.update", true), writes: writesOf, expected: updateExpected,
    run: async (ctx, args) => {
      const table = await readTable(ctx.home, args.entity as string);
      const values = checkedWrite(table, args.values, "update");
      const record = requireRecord(table, args.key as string);
      await table.sheets.writeRow(table.source, record.row, rowWith(table, table.cells[record.row - 1] ?? [], values));
      return { entity: table.entityName, key: args.key, record: { ...record.values, ...values } };
    },
  },
];
