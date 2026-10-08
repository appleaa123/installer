import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ActionFailure } from "./failure.js";
import { runProcess } from "./headless.js";
import { InputError } from "./inputs.js";

/** Keychain item: service `installer`, account `<secret id>`, one per OS user (D51). */
export const KEYCHAIN_SERVICE = "installer";
export const KEYCHAIN_ENV = "INSTALLER_KEYCHAIN";
export const KEYCHAIN_DIR_ENV = "INSTALLER_KEYCHAIN_DIR";
export const SECRET_ID_PATTERN = /^[a-z0-9-]+$/;
const KEYCHAIN_TIMEOUT_MS = 30_000;
/** `security` exits 44 when no item matches (verified live, macOS). */
const MAC_NOT_FOUND = 44;

type Env = Readonly<Record<string, string | undefined>>;

export interface Keychain {
  readonly get: (id: string) => Promise<string | null>;
  readonly set: (id: string, value: string) => Promise<void>;
  readonly delete: (id: string) => Promise<boolean>;
}

export function requireSecretId(id: string): string {
  if (!SECRET_ID_PATTERN.test(id)) throw new InputError(`Secret id '${id}' must be lowercase letters, digits and dashes`);
  return id;
}

/** Keys are single lines: a control character would break the keychain command protocol. */
export function requireSecretValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new InputError("The secret is empty");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new InputError("The secret must be a single line");
  return trimmed;
}

/** The `security -i` script that stores a value read from stdin, never from argv (verified live: `\` and `"` escaped). */
export function macAddScript(id: string, value: string): string {
  const escaped = value.replace(/[\\"]/g, (char) => `\\${char}`);
  return `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -w "${escaped}"\n`;
}

async function keychainCommand(argv: readonly string[], input?: string): Promise<{ code: number | null; stdout: string; error?: string }> {
  return runProcess(argv, process.cwd(), KEYCHAIN_TIMEOUT_MS, input);
}

function requireOk(result: { code: number | null; error?: string }, what: string): void {
  if (result.code === 0) return;
  throw new ActionFailure(`The keychain could not ${what} (${result.error ?? `exit ${result.code}`})`);
}

const macBackend: Keychain = {
  get: async (id) => {
    const result = await keychainCommand(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w"]);
    if (result.code === MAC_NOT_FOUND) return null;
    requireOk(result, `read '${id}'`);
    return result.stdout.replace(/\n$/, "");
  },
  set: async (id, value) => requireOk(await keychainCommand(["security", "-i"], macAddScript(id, value)), `store '${id}'`),
  delete: async (id) => {
    const result = await keychainCommand(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id]);
    if (result.code === MAC_NOT_FOUND) return false;
    requireOk(result, `delete '${id}'`);
    return true;
  },
};

/** Linux Secret Service through `secret-tool`; the value travels on stdin. Not verified on this project's machine. */
const linuxBackend: Keychain = {
  get: async (id) => {
    const result = await keychainCommand(["secret-tool", "lookup", "service", KEYCHAIN_SERVICE, "account", id]);
    if (result.code === 1) return null;
    requireOk(result, `read '${id}'`);
    return result.stdout.replace(/\n$/, "");
  },
  set: async (id, value) => {
    const argv = ["secret-tool", "store", `--label=${KEYCHAIN_SERVICE}:${id}`, "service", KEYCHAIN_SERVICE, "account", id];
    requireOk(await keychainCommand(argv, value), `store '${id}'`);
  },
  delete: async (id) => (await keychainCommand(["secret-tool", "clear", "service", KEYCHAIN_SERVICE, "account", id])).code === 0,
};

/** Files of mode 0600 in a private folder; used by the test suite and as the fallback where no keychain exists. */
function fileBackend(dir: string): Keychain {
  const pathOf = (id: string): string => join(dir, id);
  return {
    get: async (id) => {
      try {
        return await readFile(pathOf(id), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new ActionFailure(`The keychain folder ${dir} cannot be read (${(error as NodeJS.ErrnoException).code})`);
      }
    },
    set: async (id, value) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(pathOf(id), value, { encoding: "utf8", mode: 0o600 });
    },
    delete: async (id) => {
      const existed = (await fileBackend(dir).get(id)) !== null;
      await rm(pathOf(id), { force: true });
      return existed;
    },
  };
}

export function selectKeychain(env: Env = process.env): Keychain {
  const chosen = env[KEYCHAIN_ENV];
  if (chosen === "file") {
    const dir = env[KEYCHAIN_DIR_ENV];
    if (!dir) throw new ActionFailure(`${KEYCHAIN_ENV}=file needs ${KEYCHAIN_DIR_ENV} to name a private folder`);
    return fileBackend(resolve(dir));
  }
  if (chosen !== undefined && chosen !== "") throw new ActionFailure(`${KEYCHAIN_ENV} must be unset or 'file', got '${chosen}'`);
  if (process.platform === "darwin") return macBackend;
  if (process.platform === "linux") return linuxBackend;
  throw new ActionFailure(`No keychain backend for ${process.platform} yet; set ${KEYCHAIN_ENV}=file and ${KEYCHAIN_DIR_ENV}=<private folder>`);
}

export async function getSecret(id: string, env?: Env): Promise<string | null> {
  return selectKeychain(env).get(requireSecretId(id));
}

export async function setSecret(id: string, value: string, env?: Env): Promise<void> {
  return selectKeychain(env).set(requireSecretId(id), requireSecretValue(value));
}

export async function deleteSecret(id: string, env?: Env): Promise<boolean> {
  return selectKeychain(env).delete(requireSecretId(id));
}
