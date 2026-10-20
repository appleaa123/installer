import type { InputKind, StepInput } from "./types.js";

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Kinds that are collected by the local browser page, never through submit (R4). */
export const AGENT_FORBIDDEN_KINDS: readonly InputKind[] = ["secret", "oauth"];

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** A URL a key may be sent to: https, or this machine's own loopback (the test servers). */
export const SAFE_URL = /^(https:\/\/|http:\/\/127\.0\.0\.1(:\d+)?\/)/;
const CRON_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function validCronPart(part: string, min: number, max: number): boolean {
  const [base, step, ...rest] = part.split("/");
  if (rest.length > 0 || base === undefined || base === "") return false;
  if (step !== undefined && !/^[1-9]\d*$/.test(step)) return false;
  if (base === "*") return true;
  const match = /^(\d+)(?:-(\d+))?$/.exec(base);
  if (!match) return false;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  return low >= min && high <= max && low <= high;
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const range = CRON_RANGES[index];
    return range !== undefined && field.split(",").every((part) => validCronPart(part, range[0], range[1]));
  });
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new InputError(`${what} must be a non-empty string`);
  return value.trim();
}

function validateChoice(input: StepInput, value: unknown): unknown {
  const options = input.options ?? [];
  if (input.kind === "choice") {
    if (typeof value !== "string" || !options.includes(value)) {
      throw new InputError(`Answer must be one of: ${options.join(", ")}`);
    }
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) throw new InputError("Select at least one option");
  if (!value.every((item) => typeof item === "string" && options.includes(item))) {
    throw new InputError(`Every selection must be one of: ${options.join(", ")}`);
  }
  return [...new Set(value as string[])];
}

export function validateInput(input: StepInput | undefined, value: unknown): unknown {
  if (!input) throw new InputError("This step takes no input");
  if (AGENT_FORBIDDEN_KINDS.includes(input.kind)) {
    throw new InputError(
      `'${input.kind}' values are never accepted through submit; they are collected by the local browser page`,
    );
  }
  switch (input.kind) {
    case "text":
    case "file":
      return requireString(value, "Answer");
    case "choice":
    case "multi_choice":
      return validateChoice(input, value);
    case "confirm":
      if (typeof value !== "boolean") throw new InputError("Answer must be true or false");
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new InputError("Answer must be a number");
      return value;
    case "time":
      if (typeof value !== "string" || !TIME_PATTERN.test(value)) throw new InputError("Time must be HH:MM (24-hour)");
      return value;
    case "url": {
      const url = requireString(value, "Answer").trim();
      if (!SAFE_URL.test(url)) throw new InputError(`The address must start with https://, got '${url}'`);
      return url;
    }
    case "cron":
      if (typeof value !== "string" || !isValidCron(value)) throw new InputError("Schedule must be a 5-field cron expression");
      return value.trim();
    default:
      throw new InputError(`Unsupported input kind '${input.kind}'`);
  }
}
