import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setSecret } from "../../src/core/keychain.js";
import { runCli } from "../helpers/cli.js";
import { BOT_TOKEN, startFakeTelegram, type FakeTelegram } from "../helpers/fake-telegram.js";
import { FIXTURE_REF } from "../helpers/memory-deps.js";
import { makeTempHome } from "../helpers/temp-home.js";

let telegram: FakeTelegram;
beforeAll(async () => {
  telegram = await startFakeTelegram();
});
afterAll(() => telegram.stop());

/** An install in a temp home, and a private file keychain that the CLI child process uses too. */
async function install(secrets: Record<string, string>) {
  const env = { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: await makeTempHome(), ...telegram.env };
  for (const [id, value] of Object.entries(secrets)) await setSecret(id, value, env);
  const home = await makeTempHome();
  runCli(["start", "--solution", FIXTURE_REF], { home, env });
  return { home, env };
}

describe("installer channel and disconnect from the shell (D73)", () => {
  it("verifies the Telegram bot, lists it, and disconnects it", async () => {
    const { home, env } = await install({ telegram: BOT_TOKEN });
    const verified = runCli(["channel", "telegram"], { home, env });
    expect(verified.code).toBe(0);
    expect(verified.json).toMatchObject({ status: "verified", channel: "telegram", bot: "@desk_test_bot" });
    expect(runCli(["channel"], { home, env }).json).toMatchObject({ channels: [{ channel: "telegram" }] });
    expect(runCli(["disconnect", "telegram"], { home, env }).json).toMatchObject({ status: "disconnected", connector: "telegram", secret_deleted: true });
    expect(runCli(["channel"], { home, env }).json).toEqual({ channels: [] });
  });

  it("exits 2 with what to do when no token is stored, or the channel is unknown", async () => {
    const { home, env } = await install({});
    const missing = runCli(["channel", "telegram"], { home, env });
    expect(missing.code).toBe(2);
    expect(missing.json).toEqual({ error: "No telegram secret is stored: run 'installer secret telegram' and enter it on the page that opens", code: 2 });
    expect(runCli(["channel", "fax"], { home, env }).code).toBe(2);
  });
});
