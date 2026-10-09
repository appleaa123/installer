import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

/** D48: `INSTALLER_LIVE=1` runs only tests/live/ (real Skills Wiki, real keychain, real agent); otherwise they are left out. */
const live = process.env.INSTALLER_LIVE === "1";
// Offline tests never touch the real OS keychain: a throwaway file keychain per run (D51). Live tests use the real one.
const keychain = live ? {} : { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")) };

export default defineConfig({
  test: {
    include: live ? ["tests/live/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...(live ? [] : ["tests/live/**"])],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    env: {
      // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
      INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles"),
      ...keychain,
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
      // Host readiness never reads the real OS settings in a test run (D104); tests pass a fake CommandRunner.
      INSTALLER_HOST_CHECKS: "none",
      // `installer certify` never runs the suite inside the suite (D116); the real run is a person's task.
      INSTALLER_CERTIFY_SUITES: "none",
      // In-process tests run from src/; the MCP headers helper must still name the built CLI (D52).
      INSTALLER_CLI: resolve("dist/cli.js"),
    },
  },
});
