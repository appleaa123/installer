import { describe, expect, it, vi } from "vitest";
import { disconnect } from "../../src/core/disconnect.js";
import { getSecret, setSecret } from "../../src/core/keychain.js";
import { makeTempHome } from "../helpers/temp-home.js";

vi.mock("../../src/core/connectors.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/core/connectors.js")>();
  return { ...original, loadConnector: async () => Promise.reject(new Error("checksum mismatch")) };
});

describe("disconnect with a connector file that fails its checksum (review finding 3)", () => {
  it("still deletes the sign-in and says the definition could not be read", async () => {
    const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome() };
    vi.stubEnv("INSTALLER_KEYCHAIN_DIR", env.INSTALLER_KEYCHAIN_DIR);
    await setSecret("google", "signed-in", env);
    const result = await disconnect(await makeTempHome(), "google-sheets", () => "2026-01-01T00:00:00.000Z");
    expect(result).toMatchObject({ status: "disconnected", connector: "google-sheets", secret_deleted: true });
    await expect(getSecret("google", env)).resolves.toBeNull();
    vi.unstubAllEnvs();
  });
});
