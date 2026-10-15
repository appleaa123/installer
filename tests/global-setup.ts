import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_CWD_PREFIX } from "./helpers/cli.js";

/** Files an install writes into its install folder (9.12 item 2); a test run must never write them into the repo. */
const WATCHED = ["CLAUDE.md", "AGENTS.md", join(".claude", "skills")];

/** Builds dist/ once so e2e tests can spawn the real CLI quickly; the returned teardown guards the repo. */
export default function setup(): () => void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
    stdio: "inherit",
  });
  const startedMs = Date.now();
  const before = WATCHED.filter((path) => existsSync(path));
  return () => {
    for (const name of readdirSync(tmpdir()).filter((entry) => entry.startsWith(CLI_CWD_PREFIX))) {
      const path = join(tmpdir(), name);
      if (statSync(path).mtimeMs >= startedMs) rmSync(path, { recursive: true, force: true });
    }
    const added = WATCHED.filter((path) => existsSync(path) && !before.includes(path));
    if (added.length > 0) throw new Error(`Tests wrote into the repo: ${added.join(", ")}`);
  };
}
