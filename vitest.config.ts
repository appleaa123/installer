import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    testTimeout: 60_000,
    // Operator-only folder of extra runtime profiles; solutions name them by id (D34).
    env: { INSTALLER_PROFILE_DIR: resolve("tests/fixtures/profiles") },
  },
});
