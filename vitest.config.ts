import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    env: {
      // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
      INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles"),
      // Tests never touch the real OS keychain: a throwaway file keychain per run (D51).
      INSTALLER_KEYCHAIN: "file",
      INSTALLER_KEYCHAIN_DIR: mkdtempSync(join(tmpdir(), "installer-keychain-")),
      // `installer secret` must never open a browser tab during a test run.
      INSTALLER_BROWSER: "none",
    },
  },
});
