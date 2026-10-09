import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnable, type ShimOptions } from "../../src/core/win-shim.js";

const NPM = "C:\\Users\\ada\\AppData\\Roaming\\npm";
const TOOLS = "C:\\Tools";
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const shim = (name: string): string => readFileSync(`tests/fixtures/win-shims/${name}.cmd`, "utf8");

/** A Windows machine made of a few files; nothing is read from this computer's disk. */
function windows(files: Readonly<Record<string, string>>, env: Readonly<Record<string, string>> = { PATH: `${TOOLS};${NPM}` }): ShimOptions & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    platform: "win32", env, nodePath: NODE, reads,
    files: {
      exists: async (path) => Object.hasOwn(files, path),
      read: async (path) => {
        reads.push(path);
        return files[path] ?? "";
      },
    },
  };
}

describe("commands on Windows without a shell (D115)", () => {
  it("hands every other platform's argv back unchanged and reads nothing", async () => {
    const options = windows({});
    await expect(spawnable(["claude", "-p", "hi"], { ...options, platform: "darwin" })).resolves.toEqual({ argv: ["claude", "-p", "hi"] });
    expect(options.reads).toEqual([]);
  });

  it("runs an .exe found on PATH as it is", async () => {
    await expect(spawnable(["agent", "--version"], windows({ [`${TOOLS}\\agent.exe`]: "" }))).resolves.toEqual({ argv: [`${TOOLS}\\agent.exe`, "--version"] });
  });

  it("turns npm's shim into node and the script it names, with the arguments as they were", async () => {
    const options = windows({ [`${NPM}\\claude.cmd`]: shim("npm-shim") });
    const prompt = 'say "hi" & del *.* | echo %PATH%';
    await expect(spawnable(["claude", "-p", prompt], options)).resolves.toEqual({ argv: [NODE, `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`, "-p", prompt] });
  });

  it("uses the node.exe next to the shim when there is one, as the shim itself would", async () => {
    const options = windows({ [`${NPM}\\claude.cmd`]: shim("npm-shim"), [`${NPM}\\node.exe`]: "" });
    await expect(spawnable(["claude"], options)).resolves.toEqual({ argv: [`${NPM}\\node.exe`, `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`] });
  });

  it("reads the shim older npm versions wrote", async () => {
    const options = windows({ [`${NPM}\\agent.cmd`]: shim("older-shim") });
    await expect(spawnable(["agent", "-v"], options)).resolves.toEqual({ argv: [NODE, `${NPM}\\node_modules\\example-agent\\bin\\agent.js`, "-v"] });
  });

  it("takes the first PATH folder and the first PATHEXT ending that match", async () => {
    const options = windows({ [`${TOOLS}\\agent.cmd`]: shim("older-shim"), [`${NPM}\\agent.exe`]: "", [`${TOOLS}\\agent.exe`]: "" }, { Path: `${TOOLS};${NPM}`, PATHEXT: ".EXE;.CMD" });
    await expect(spawnable(["agent"], options)).resolves.toEqual({ argv: [`${TOOLS}\\agent.exe`] });
  });

  it("finds a command given with its folder", async () => {
    const options = windows({ [`${NPM}\\claude.cmd`]: shim("npm-shim") });
    await expect(spawnable([`${NPM}\\claude`, "--version"], options)).resolves.toMatchObject({ argv: [NODE, expect.stringMatching(/cli\.js$/), "--version"] });
  });

  it("refuses a batch file that is not an npm shim, without running it", async () => {
    const options = windows({ [`${TOOLS}\\agent.bat`]: shim("not-a-shim") });
    await expect(spawnable(["agent"], options)).resolves.toEqual({ error: "'agent.bat' is a batch file, not an npm shim; the engine never runs batch files, because they need a shell" });
  });

  it("refuses a shim whose script lies outside the shim's folder", async () => {
    const options = windows({ [`${NPM}\\agent.cmd`]: shim("outside-shim") });
    await expect(spawnable(["agent"], options)).resolves.toEqual({ error: "'agent.cmd' points outside its own folder; the engine does not run it" });
  });

  it("names a command that is on no PATH folder as not installed", async () => {
    await expect(spawnable(["claude"], windows({}))).resolves.toEqual({ error: "'claude' is not installed" });
  });
});
