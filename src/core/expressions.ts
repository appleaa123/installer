import { canonicalJson } from "./audit.js";
import { InputError } from "./inputs.js";

/**
 * The workflow expression language (spec §10.2): `${path}` references in step arguments, and `when` conditions
 * built from paths, literals, comparisons, `and` / `or` / `not`, `in` and `len(…)`. Side-effect free, no
 * arbitrary code. A path is `<root>(.name | .0 | [0] | [*])*`; `[*]` maps the rest of the path over a list.
 * Values are inserted as they are and never scanned again, so a judge's output that contains `${…}` stays text.
 */
export type Scope = Readonly<Record<string, unknown>>;

export class ExpressionError extends InputError {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

const PATH = /^[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+|\[\d+\]|\[\*\])*$/i;
const REFERENCE = /\$\{([^}]*)\}/g;
const WHOLE = /^\$\{([^}]*)\}$/;

/** The path's parts: names, list indexes (numbers) and `*`. */
export function parsePath(path: string): readonly (string | number)[] {
  const trimmed = path.trim();
  if (!PATH.test(trimmed)) throw new ExpressionError(`'${path}' is not a valid path (for example fetch.items[0].from)`);
  return [...trimmed.matchAll(/[a-z_][a-z0-9_]*|\d+|\*/gi)].map(([part]) => (/^\d+$/.test(part) ? Number(part) : part));
}

function walk(value: unknown, parts: readonly (string | number)[]): unknown {
  if (parts.length === 0) return value;
  const [head, ...rest] = parts;
  if (head === "*") return Array.isArray(value) ? value.map((entry) => walk(entry, rest)) : undefined;
  if (typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) return typeof head === "number" ? walk(value[head], rest) : undefined;
  return Object.hasOwn(value, String(head)) ? walk((value as Record<string, unknown>)[String(head)], rest) : undefined;
}

/** The value at `path`, or undefined when any part is missing. */
export function lookup(scope: Scope, path: string): unknown {
  return walk(scope, parsePath(path));
}

/** The root names a template refers to (for checks when a workflow is loaded). */
export function templateRoots(value: unknown): readonly string[] {
  if (typeof value === "string") return [...value.matchAll(REFERENCE)].map((match) => String(parsePath(match[1] ?? "")[0]));
  if (Array.isArray(value)) return value.flatMap(templateRoots);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(templateRoots);
  return [];
}

function required(scope: Scope, path: string): unknown {
  const value = lookup(scope, path);
  if (value === undefined) throw new ExpressionError(`\${${path.trim()}} has no value`);
  return value;
}

/** Fills `${path}` references: a string that is one whole reference becomes the value itself, anything else text. */
export function interpolate(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return required(scope, whole[1] ?? "");
    return value.replace(REFERENCE, (_all, path: string) => {
      const found = required(scope, path);
      return typeof found === "string" ? found : JSON.stringify(found);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => interpolate(entry, scope));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, interpolate(entry, scope)]));
  return value;
}

export type Expr =
  | { readonly kind: "literal"; readonly value: unknown }
  | { readonly kind: "path"; readonly path: string }
  | { readonly kind: "len"; readonly arg: Expr }
  | { readonly kind: "not"; readonly arg: Expr }
  | { readonly kind: "binary"; readonly op: string; readonly left: Expr; readonly right: Expr };

const TOKEN = /\s*(==|!=|<=|>=|<|>|\(|\)|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+|\[\d+\]|\[\*\])*)/giy;
const COMPARE = ["==", "!=", "<", "<=", ">", ">=", "in"];

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    if (text.slice(TOKEN.lastIndex).trim() === "") break;
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(text);
    if (!match?.[1]) throw new ExpressionError(`Cannot read the condition '${text}' at '${text.slice(at).trim()}'`);
    tokens.push(match[1]);
  }
  return tokens;
}

class Parser {
  private index = 0;
  constructor(private readonly tokens: readonly string[], private readonly text: string) {}

  private peek = (): string | undefined => this.tokens[this.index];
  private take = (): string | undefined => this.tokens[this.index++];
  private fail = (why: string): never => {
    throw new ExpressionError(`Condition '${this.text}': ${why}`);
  };

  parse(): Expr {
    const expr = this.or();
    if (this.peek() !== undefined) this.fail(`unexpected '${this.peek()}'`);
    return expr;
  }

  private or(): Expr {
    let left = this.and();
    while (this.peek() === "or") left = { kind: "binary", op: (this.take(), "or"), left, right: this.and() };
    return left;
  }

  private and(): Expr {
    let left = this.not();
    while (this.peek() === "and") left = { kind: "binary", op: (this.take(), "and"), left, right: this.not() };
    return left;
  }

  private not(): Expr {
    if (this.peek() !== "not") return this.compare();
    this.take();
    return { kind: "not", arg: this.not() };
  }

  private compare(): Expr {
    const left = this.primary();
    const op = this.peek();
    if (op === undefined || !COMPARE.includes(op)) return left;
    this.take();
    return { kind: "binary", op, left, right: this.primary() };
  }

  private primary(): Expr {
    const token = this.take() ?? this.fail("it ends too early");
    if (token === "(") {
      const inner = this.or();
      return this.take() === ")" ? inner : this.fail("a ')' is missing");
    }
    if (token === "len") {
      if (this.take() !== "(") this.fail("len needs '(…)'");
      const arg = this.or();
      return this.take() === ")" ? { kind: "len", arg } : this.fail("a ')' is missing after len(");
    }
    if (/^-?\d/.test(token)) return { kind: "literal", value: Number(token) };
    if (/^['"]/.test(token)) return { kind: "literal", value: token.slice(1, -1) };
    if (token === "true" || token === "false" || token === "null") return { kind: "literal", value: JSON.parse(token) as unknown };
    if (["and", "or", "not", "in", ")"].includes(token) || COMPARE.includes(token)) return this.fail(`unexpected '${token}'`);
    return { kind: "path", path: (parsePath(token), token) };
  }
}

export function parseCondition(text: string): Expr {
  return new Parser(tokenize(text), text).parse();
}

/** The paths a condition reads (for checks when a workflow is loaded). */
export function conditionRoots(expr: Expr): readonly string[] {
  if (expr.kind === "path") return [String(parsePath(expr.path)[0])];
  if (expr.kind === "len" || expr.kind === "not") return conditionRoots(expr.arg);
  if (expr.kind === "binary") return [...conditionRoots(expr.left), ...conditionRoots(expr.right)];
  return [];
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== 0 && value !== "";
}

function size(value: unknown): number {
  if (Array.isArray(value) || typeof value === "string") return value.length;
  return typeof value === "object" && value !== null ? Object.keys(value).length : 0;
}

const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function ordered(op: string, a: unknown, b: unknown): boolean {
  const comparable = (typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string");
  if (!comparable) return false;
  const [x, y] = [a as number | string, b as number | string];
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
}

function contains(item: unknown, list: unknown): boolean {
  if (Array.isArray(list)) return list.some((entry) => same(entry, item));
  return typeof list === "string" && typeof item === "string" && list.includes(item);
}

export function evaluate(expr: Expr, scope: Scope): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "path":
      return lookup(scope, expr.path) ?? null;
    case "len":
      return size(evaluate(expr.arg, scope));
    case "not":
      return !truthy(evaluate(expr.arg, scope));
    case "binary": {
      if (expr.op === "and") return truthy(evaluate(expr.left, scope)) && truthy(evaluate(expr.right, scope));
      if (expr.op === "or") return truthy(evaluate(expr.left, scope)) || truthy(evaluate(expr.right, scope));
      const [left, right] = [evaluate(expr.left, scope), evaluate(expr.right, scope)];
      if (expr.op === "==") return same(left, right);
      if (expr.op === "!=") return !same(left, right);
      if (expr.op === "in") return contains(left, right);
      return ordered(expr.op, left, right);
    }
  }
}

/** A `when` condition, true or false. */
export function holds(condition: string, scope: Scope): boolean {
  return truthy(evaluate(parseCondition(condition), scope));
}
