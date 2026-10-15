import { basename } from "node:path";
import { describe, expect, it } from "vitest";

describe("the test keychain (D51)", () => {
  it("is this test file's own, so a test that deletes secrets (uninstall, disconnect) cannot break another file running at the same time", () => {
    expect(process.env.INSTALLER_KEYCHAIN).toBe("file");
    expect(basename(process.env.INSTALLER_KEYCHAIN_DIR ?? "")).toMatch(/^installer-keychain-file-/);
  });
});
