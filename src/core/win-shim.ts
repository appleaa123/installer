import { access, readFile } from "node:fs/promises";
import { win32 } from "node:path";

/**
 * Commands on Windows without a shell (Plan 2's open ruling, D115). Node refuses to spawn a `.cmd` or `.bat` file
 * without a shell, and a shell would read a prompt's text as commands, so the engine never uses one. Instead it
 * finds the command on PATH itself: an `.exe` or `.com` runs as it is; an npm shim (`claude.cmd`, written by npm's
 * cmd-shim when a package is installed globally) is read, never run, and the script it names runs as
 * `node <script>`; any other batch file, and a shim whose script lies outside the shim's own folder, is refused.
 * Every other platform gets the argv back unchanged.
 */
export interface ShimFiles {
  readonly exists: (path: string) => Promise<boolean>;
  readonly read: (path: string) => Promise<string>;
}

export interface ShimOptions {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly files: ShimFiles;
  /** The node that runs a shim's script when no `node.exe` sits next to the shim (npm's own rule). */
  readonly nodePath: string;
}

export type Spawnable = { readonly argv: readonly string[] } | { readonly error: string };

const DISK: ShimFiles = {
  exists: async (path) => access(path).then(() => true, () => false),
  read: (path) => readFile(path, "utf8"),
};

export const SHIM_DEFAULTS: ShimOptions = { platform: process.platform, env: process.env, files: DISK, nodePath: process.execPath };

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** cmd-shim's last line: `"%_prog%"  "%dp0%\node_modules\…\cli.js" %*`; older npm wrote `"%~dp0\…\cli.js" %*`. */
const SHIM_TARGET = /"%~?dp0%?\\([^"%]+\.[cm]?js)"\s+%\*/i;

/** The full path of `name`: as given when it has a folder, otherwise the first PATH folder holding it with a PATHEXT ending. */
async function findOnPath(name: string, options: ShimOptions): Promise<string | null> {
  const endings = (options.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter((ending) => ending !== "").map((ending) => ending.toLowerCase());
  const hasEnding = endings.includes(win32.extname(name).toLowerCase());
  const names = hasEnding ? [name] : endings.map((ending) => `${name}${ending}`);
  const folders = name.includes("\\") || name.includes("/") ? [""] : (options.env.PATH ?? options.env.Path ?? "").split(";").filter((folder) => folder !== "");
  for (const folder of folders) {
    for (const candidate of names) {
      const path = folder === "" ? win32.resolve(candidate) : win32.join(folder, candidate);
      if (await options.files.exists(path)) return path;
    }
  }
  return null;
}

/** An npm shim becomes `node <script>`; anything else that needs a shell is refused. */
async function fromShim(path: string, rest: readonly string[], options: ShimOptions): Promise<Spawnable> {
  const folder = win32.dirname(path);
  const target = SHIM_TARGET.exec(await options.files.read(path))?.[1];
  if (!target) return { error: `'${win32.basename(path)}' is a batch file, not an npm shim; the engine never runs batch files, because they need a shell` };
  const script = win32.resolve(folder, target);
  if (!script.toLowerCase().startsWith(`${folder.toLowerCase()}\\`)) return { error: `'${win32.basename(path)}' points outside its own folder; the engine does not run it` };
  const bundled = win32.join(folder, "node.exe");
  return { argv: [(await options.files.exists(bundled)) ? bundled : options.nodePath, script, ...rest] };
}

/** What to spawn for `argv` without a shell. */
export async function spawnable(argv: readonly string[], options: ShimOptions = SHIM_DEFAULTS): Promise<Spawnable> {
  const [file = "", ...rest] = argv;
  if (options.platform !== "win32") return { argv };
  const path = await findOnPath(file, options);
  if (path === null) return { error: `'${file}' is not installed` };
  const ending = win32.extname(path).toLowerCase();
  if (ending === ".cmd" || ending === ".bat") return fromShim(path, rest, options);
  return { argv: [path, ...rest] };
}
