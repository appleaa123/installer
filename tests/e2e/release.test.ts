import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { makeTempHome } from "../helpers/temp-home.js";

const VERSION = (JSON.parse(await readFile("package.json", "utf8")) as { version: string }).version;

/** What `npm pack` would put in the package, from npm itself; no network, nothing is published. */
function packed(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { files: { path: string }[] }[])[0]?.files.map((file) => file.path) ?? [];
}

describe("release readiness (D119)", () => {
  it("taskfollow version prints the installer's version and Node's", async () => {
    const result = runCli(["version"], { home: await makeTempHome() });
    expect(result.code).toBe(0);
    expect(result.json).toEqual({ installer: VERSION, node: process.version });
  });

  it("packs the CLI, both profiles, the connector, the starter and INSTALL.md, and nothing from tests, src or docs", () => {
    const files = packed();
    expect(files).toEqual(expect.arrayContaining([
      "package.json", "README.md", "INSTALL.md", "dist/cli.js", "dist/core/certify.js", "dist/core/win-shim.js",
      "profiles/claude-code.json", "profiles/codex.json", "connectors/google-sheets/1/connector.json", "solutions/starter.json",
    ]));
    expect(files.filter((path) => /^(tests|src|docs|node_modules|certification)\//.test(path) || path.includes(".env") || path.endsWith(".ts"))).toEqual([]);
  });

  it("builds before packing, so a package never ships a stale build, and is not private, so the owner can publish (D175)", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as { private?: boolean; scripts: Record<string, string> };
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.private).toBeUndefined();
  });

  it("ships a CLI that starts with a node shebang", async () => {
    expect((await readFile("dist/cli.js", "utf8")).split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
