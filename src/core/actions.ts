import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { InputError } from "./inputs.js";
import type { Action, Check } from "./types.js";

export interface CheckResult {
  readonly ok: boolean;
  readonly hint?: string;
}

type Args = Readonly<Record<string, unknown>>;

/** Every file the engine touches must stay inside engine_home (D34). */
export function resolveInHome(home: string, relative: string): string {
  const root = resolve(home);
  const target = resolve(root, relative);
  if (target === root || !target.startsWith(root + sep)) {
    throw new InputError(`Path '${relative}' is outside the engine home`);
  }
  return target;
}

function stringArg(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new InputError(`Argument '${key}' must be a string`);
  return value;
}

const ACTIONS: Readonly<Record<string, (home: string, args: Args) => Promise<void>>> = {
  noop: async () => undefined,
  write_file: async (home, args) => {
    const target = resolveInHome(home, stringArg(args, "path"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, typeof args.content === "string" ? args.content : "", { encoding: "utf8", mode: 0o600 });
  },
};

const CHECKS: Readonly<Record<string, (home: string, args: Args) => Promise<CheckResult>>> = {
  file_exists: async (home, args) => {
    const path = stringArg(args, "path");
    try {
      await access(resolveInHome(home, path));
      return { ok: true };
    } catch (error) {
      if (error instanceof InputError) throw error;
      return { ok: false, hint: typeof args.hint === "string" ? args.hint : `Expected ${path} to exist` };
    }
  },
};

export const KNOWN_ACTIONS: readonly string[] = Object.keys(ACTIONS);
export const KNOWN_CHECKS: readonly string[] = Object.keys(CHECKS);

export async function runAction(home: string, action: Action): Promise<void> {
  if (!Object.hasOwn(ACTIONS, action.action)) throw new InputError(`Unknown action '${action.action}'`);
  const run = ACTIONS[action.action];
  await run(home, action.args ?? {});
}

export async function runCheck(home: string, check: Check): Promise<CheckResult> {
  if (!Object.hasOwn(CHECKS, check.check)) throw new InputError(`Unknown check '${check.check}'`);
  const run = CHECKS[check.check];
  return run(home, check.args ?? {});
}
