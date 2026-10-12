import { canonicalJson } from "./audit.js";
import { InputError } from "./inputs.js";

/**
 * The JSON Schema subset a judge's output schema may use (D16: the runner validates every judge answer itself,
 * whatever the runtime supports). Keywords: the ones in KEYWORDS below; description and title are ignored.
 * `additionalProperties` must be true or false.
 * Any other keyword is refused when the workflow is loaded, so a schema never silently checks less than it says.
 */
const TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"] as const;
const KEYWORDS = Object.keys({
  type: 1, properties: 1, required: 1, additionalProperties: 1, items: 1, enum: 1, minimum: 1, maximum: 1,
  minLength: 1, maxLength: 1, minItems: 1, maxItems: 1, description: 1, title: 1,
});
const NUMBER_KEYWORDS = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];
const MAX_ERRORS = 10;

type Schema = Readonly<Record<string, unknown>>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function typeList(schema: Schema): readonly string[] {
  const type = schema.type;
  return type === undefined ? [] : Array.isArray(type) ? (type as string[]) : [type as string];
}

/** Throws an InputError naming the first part of the schema that this subset does not support. */
export function checkSchema(schema: unknown, where = "schema"): void {
  if (!isRecord(schema)) throw new InputError(`${where} must be a JSON object`);
  const unknown = Object.keys(schema).find((key) => !KEYWORDS.includes(key));
  if (unknown !== undefined) throw new InputError(`${where} uses '${unknown}', which the runner does not check; use only ${KEYWORDS.join(", ")}`);
  if (!typeList(schema).every((type) => (TYPES as readonly string[]).includes(type))) throw new InputError(`${where}.type must be one of ${TYPES.join(", ")}`);
  const { properties: fields } = schema;
  if (fields !== undefined) {
    if (!isRecord(fields)) throw new InputError(`In ${where}, properties: must be an object of fields`);
    for (const [name, child] of Object.entries(fields)) checkSchema(child, `${where} > ${name}`);
  }
  if (schema.items !== undefined) checkSchema(schema.items, `${where} > items`);
  if (schema.required !== undefined && !(Array.isArray(schema.required) && schema.required.every((name) => typeof name === "string"))) throw new InputError(`${where}.required must list names`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new InputError(`${where}.additionalProperties must be true or false`);
  if (schema.enum !== undefined && !(Array.isArray(schema.enum) && schema.enum.length > 0)) throw new InputError(`${where}.enum must list the allowed values`);
  const notNumber = NUMBER_KEYWORDS.find((key) => schema[key] !== undefined && typeof schema[key] !== "number");
  if (notNumber !== undefined) throw new InputError(`${where}.${notNumber} must be a number`);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

function bounds(schema: Schema, value: unknown, at: string): string[] {
  const errors: string[] = [];
  const number = (key: string): number | undefined => schema[key] as number | undefined;
  if (typeof value === "number") {
    if (number("minimum") !== undefined && value < (number("minimum") ?? 0)) errors.push(`${at} is below ${number("minimum")}`);
    if (number("maximum") !== undefined && value > (number("maximum") ?? 0)) errors.push(`${at} is above ${number("maximum")}`);
  }
  const length = typeof value === "string" ? value.length : undefined;
  if (length !== undefined && length < (number("minLength") ?? 0)) errors.push(`${at} is shorter than ${number("minLength")}`);
  if (length !== undefined && length > (number("maxLength") ?? Infinity)) errors.push(`${at} is longer than ${number("maxLength")}`);
  const count = Array.isArray(value) ? value.length : undefined;
  if (count !== undefined && count < (number("minItems") ?? 0)) errors.push(`${at} has fewer than ${number("minItems")} items`);
  if (count !== undefined && count > (number("maxItems") ?? Infinity)) errors.push(`${at} has more than ${number("maxItems")} items`);
  return errors;
}

function objectErrors(schema: Schema, value: Record<string, unknown>, at: string): string[] {
  const { properties: declared } = schema;
  const fields = (declared ?? {}) as Readonly<Record<string, Schema>>;
  const missing = ((schema.required ?? []) as string[]).filter((name) => !Object.hasOwn(value, name)).map((name) => `${at}.${name} is missing`);
  const extra = schema.additionalProperties === false ? Object.keys(value).filter((name) => !Object.hasOwn(fields, name)).map((name) => `${at}.${name} is not allowed`) : [];
  const nested = Object.entries(fields).flatMap(([name, child]) => (Object.hasOwn(value, name) ? schemaErrors(child, value[name], `${at}.${name}`) : []));
  return [...missing, ...extra, ...nested];
}

function schemaErrors(schema: Schema, value: unknown, at: string): string[] {
  const types = typeList(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) return [`${at} must be ${types.join(" or ")}, not ${typeOf(value)}`];
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => canonicalJson(option) === canonicalJson(value))) return [`${at} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`];
  const nested = isRecord(value) ? objectErrors(schema, value, at) : Array.isArray(value) && isRecord(schema.items) ? value.flatMap((item, index) => schemaErrors(schema.items as Schema, item, `${at}[${index}]`)) : [];
  return [...bounds(schema, value, at), ...nested];
}

/** Every way `value` breaks `schema` (at most ten), as short sentences; empty when it fits. */
export function validateSchema(schema: Schema, value: unknown): readonly string[] {
  return schemaErrors(schema, value, "$").slice(0, MAX_ERRORS);
}
