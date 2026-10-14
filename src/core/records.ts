import type { EntityDef } from "./contract.js";
import { contractEntity, loadMapping, loadSource, openSheets, type DataSource } from "./data-source.js";
import { ActionFailure } from "./failure.js";
import { InputError } from "./inputs.js";
import type { SheetsClient } from "./sheets.js";

/**
 * Records read through from the client's sheet on every call (§9.6: no mirror; D70: no cache in v1). Each mapped
 * field is found in row 1 by its column name, so the client may reorder or add columns; cells of columns the
 * mapping does not name are kept as they are when a row is rewritten.
 */
export type RecordValues = Readonly<Record<string, string>>;

export interface StoredRecord {
  /** The sheet row, 2 = the first row under the header. */
  readonly row: number;
  readonly values: RecordValues;
}

export interface Table {
  readonly entityName: string;
  readonly entity: EntityDef;
  readonly source: DataSource;
  readonly sheets: SheetsClient;
  readonly width: number;
  readonly cells: readonly (readonly string[])[];
  readonly columns: Readonly<Record<string, number>>;
  readonly records: readonly StoredRecord[];
}

function columnIndexes(entityName: string, header: readonly string[], mapped: Readonly<Record<string, string>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(mapped).map(([field, column]) => {
      const index = header.findIndex((cell) => cell.trim() === column);
      if (index < 0) throw new ActionFailure(`Column '${column}' (${entityName}.${field}) is no longer in row 1 of the sheet: run 'taskfollow map ${entityName}' again`);
      return [field, index];
    }),
  );
}

const valuesOf = (cells: readonly string[], columns: Readonly<Record<string, number>>): RecordValues =>
  Object.fromEntries(Object.entries(columns).map(([field, index]) => [field, (cells[index] ?? "").trim()]));

/** Reads the whole sheet once: header, mapped columns and every non-blank row. */
export async function readTable(home: string, entityName: string): Promise<Table> {
  const { entity } = await contractEntity(home, entityName);
  const source = await loadSource(home, entityName);
  if (!source) throw new InputError(`'${entityName}' is not connected to a sheet yet: run 'taskfollow connect ${entityName} --sheet <link>' first`);
  const mapping = await loadMapping(home, entityName);
  if (!mapping) throw new InputError(`The columns of '${entityName}' are not mapped yet: run 'taskfollow map ${entityName}' first`);
  const { sheets } = await openSheets();
  const cells = await sheets.readRows(source);
  const header = cells[0] ?? [];
  const columns = columnIndexes(entityName, header, mapping.columns);
  const records = cells
    .slice(1)
    .map((row, index) => ({ row: index + 2, values: valuesOf(row, columns) }))
    .filter((record) => Object.values(record.values).some((value) => value !== ""));
  return { entityName, entity, source, sheets, width: Math.max(header.length, ...Object.values(columns).map((index) => index + 1)), cells, columns, records };
}

/** The one record with this key; a key that appears twice is refused, never guessed (Review Focus 2). */
export function findByKey(table: Table, key: string): StoredRecord | null {
  const wanted = key.trim().toLowerCase();
  const matches = table.records.filter((record) => (record.values[table.entity.key] ?? "").toLowerCase() === wanted);
  if (matches.length > 1) {
    throw new ActionFailure(`The ${table.entity.key} '${key}' appears in rows ${matches.map((match) => match.row).join(" and ")} of the ${table.entityName} sheet: remove the extra copy first`);
  }
  return matches[0] ?? null;
}

export function requireRecord(table: Table, key: string): StoredRecord {
  const found = findByKey(table, key);
  if (!found) throw new InputError(`No ${table.entityName} with ${table.entity.key} '${key}'`);
  return found;
}

/** A full row: the current cells (kept for unmapped columns), with the given fields written into their columns. */
export function rowWith(table: Table, current: readonly string[], values: RecordValues): string[] {
  const base = Array.from({ length: table.width }, (_unused, index) => current[index] ?? "");
  return base.map((cell, index) => {
    const field = Object.keys(values).find((name) => table.columns[name] === index);
    return field === undefined ? cell : (values[field] ?? "");
  });
}
