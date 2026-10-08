import { InputError } from "./inputs.js";
import { FIELD_TAGS, type FieldRef, type FieldTag, type TagSource } from "./levels.js";

/**
 * The data contract a recipe declares (spec §9.2): entities, their key and typed, tagged fields.
 * Tags feed level derivation (§9.3, D59); the mapping to the client's columns lives under the engine home (§9.4).
 */
export const FIELD_TYPES = ["text", "email", "phone", "date", "datetime", "money", "number", "boolean", "enum", "url", "file_ref"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDef {
  readonly type: FieldType;
  readonly tags: readonly FieldTag[];
  readonly required: boolean;
  readonly options?: readonly string[];
}

export interface EntityDef {
  readonly key: string;
  readonly match_keys: readonly string[];
  readonly fields: Readonly<Record<string, FieldDef>>;
}

export interface DataContract {
  readonly entities: Readonly<Record<string, EntityDef>>;
}

/** A contract that cannot be used; the solution loader reports it as a SolutionError. */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

const NAME = /^[a-z][a-z0-9_]*$/;
const MAX_VALUE = 2000;
type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new ContractError(`${where} must be a list of text`);
  return value as string[];
}

function parseField(value: unknown, where: string): FieldDef {
  if (!isRecord(value)) throw new ContractError(`${where} must be an object`);
  if (!(FIELD_TYPES as readonly unknown[]).includes(value.type)) throw new ContractError(`${where}.type must be one of ${FIELD_TYPES.join(", ")}`);
  const tags = value.tags === undefined ? [] : stringList(value.tags, `${where}.tags`);
  if (!tags.every((tag) => (FIELD_TAGS as readonly string[]).includes(tag))) throw new ContractError(`${where}.tags must only use ${FIELD_TAGS.join(", ")}`);
  const type = value.type as FieldType;
  const options = value.options === undefined ? undefined : stringList(value.options, `${where}.options`);
  if (type === "enum" && (!options || options.length === 0)) throw new ContractError(`${where} is an enum and needs options`);
  return { type, tags: tags as FieldTag[], required: value.required === true, ...(options ? { options } : {}) };
}

function parseEntity(value: unknown, name: string): EntityDef {
  if (!isRecord(value) || !isRecord(value.fields)) throw new ContractError(`${name}.fields must be an object`);
  const entries = Object.entries(value.fields).map(([field, def]): [string, FieldDef] => {
    if (!NAME.test(field)) throw new ContractError(`${name}: field name '${field}' must be lowercase letters, digits and _`);
    return [field, parseField(def, `${name}.${field}`)];
  });
  const fields = Object.fromEntries(entries);
  const key = value.key;
  if (typeof key !== "string" || !Object.hasOwn(fields, key)) throw new ContractError(`${name}.key '${String(key)}' must be one of its fields`);
  const matchKeys = value.match_keys === undefined ? [key] : stringList(value.match_keys, `${name}.match_keys`);
  if (!matchKeys.every((field) => Object.hasOwn(fields, field))) throw new ContractError(`${name}.match_keys must name its fields`);
  return { key, match_keys: matchKeys, fields: { ...fields, [key]: { ...fields[key], required: true } } };
}

export function parseContract(raw: unknown): DataContract {
  if (!isRecord(raw) || !isRecord(raw.entities)) throw new ContractError("data_contract.entities must be an object");
  const entities = Object.entries(raw.entities).map(([name, entity]): [string, EntityDef] => {
    if (!NAME.test(name)) throw new ContractError(`data_contract: entity name '${name}' must be lowercase letters, digits and _`);
    return [name, parseEntity(entity, name)];
  });
  return { entities: Object.fromEntries(entities) };
}

export function requireEntity(contract: DataContract, name: string): EntityDef {
  if (!Object.hasOwn(contract.entities, name)) throw new InputError(`No entity '${name}' in the data contract; entities: ${Object.keys(contract.entities).join(", ")}`);
  return contract.entities[name] as EntityDef;
}

/** The real tag source (§9.3): tags come only from the contract the install pinned, never from the model. */
export function contractTags(contract: DataContract): TagSource {
  return (ref: FieldRef) => {
    const entity = Object.hasOwn(contract.entities, ref.entity) ? contract.entities[ref.entity] : undefined;
    return entity && Object.hasOwn(entity.fields, ref.field) ? (entity.fields[ref.field]?.tags ?? []) : [];
  };
}

/** Records hold text cells; each type has the shape a cell must have. */
const SHAPES: Partial<Record<FieldType, { readonly pattern: RegExp; readonly what: string }>> = {
  email: { pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, what: "an email address" },
  phone: { pattern: /^\+?[0-9 ().-]{3,}$/, what: "a phone number" },
  date: { pattern: /^\d{4}-\d{2}-\d{2}$/, what: "a date such as 2026-10-08" },
  datetime: { pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/, what: "a date and time such as 2026-10-08T09:30Z" },
  money: { pattern: /^-?\d+(\.\d{1,2})?$/, what: "an amount such as 12.50" },
  number: { pattern: /^-?\d+(\.\d+)?$/, what: "a number" },
  boolean: { pattern: /^(true|false)$/, what: "true or false" },
  url: { pattern: /^https?:\/\/\S+$/, what: "a web address" },
};

function checkValue(where: string, def: FieldDef, value: unknown): string {
  if (typeof value !== "string") throw new InputError(`${where} must be text`);
  const text = value.trim();
  if (text.length > MAX_VALUE) throw new InputError(`${where} is longer than ${MAX_VALUE} characters`);
  if (text === "") return text;
  const shape = SHAPES[def.type];
  if (shape && !shape.pattern.test(text)) throw new InputError(`${where} must be ${shape.what}`);
  if (def.type === "enum" && !def.options?.includes(text)) throw new InputError(`${where} must be one of ${def.options?.join(", ")}`);
  return text;
}

/** Checks values against the contract; `create` needs every required field, `update` may not touch the key. */
export function checkValues(entityName: string, entity: EntityDef, values: unknown, mode: "create" | "update"): Readonly<Record<string, string>> {
  if (!isRecord(values)) throw new InputError("values must be an object of field names to text");
  const fields = Object.keys(entity.fields);
  const checked = Object.fromEntries(
    Object.entries(values).map(([field, value]) => {
      if (!Object.hasOwn(entity.fields, field)) throw new InputError(`${entityName} has no field '${field}'; fields: ${fields.join(", ")}`);
      if (mode === "update" && field === entity.key) throw new InputError(`${entityName}'s key '${entity.key}' cannot be changed`);
      return [field, checkValue(`${entityName}.${field}`, entity.fields[field] as FieldDef, value)];
    }),
  );
  if (mode === "update" && Object.keys(checked).length === 0) throw new InputError(`Give at least one field of ${entityName} to change`);
  const missing = fields.find((field) => entity.fields[field]?.required && (mode === "create" ? !checked[field] : checked[field] === ""));
  if (missing !== undefined) throw new InputError(`${entityName} needs '${missing}'`);
  return checked;
}
