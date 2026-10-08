import { execFileSync } from "node:child_process";

/** Builds dist/ once so e2e tests can spawn the real CLI quickly. */
export default function setup(): void {
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
    stdio: "inherit",
  });
}
