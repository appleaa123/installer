import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { saveChannel } from "../../src/core/channels.js";
import { setSecret } from "../../src/core/keychain.js";
import { createInvite, joinWithCode } from "../../src/core/members.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import { saveState } from "../../src/core/state.js";
import type { StepRecord } from "../../src/core/types.js";
import { BOT_TOKEN, type FakeTelegram } from "./fake-telegram.js";
import { makeTempHome } from "./temp-home.js";

const CHANNELS_TEXT = readFileSync("tests/fixtures/solution-channels.json", "utf8");
export const ROLES = { decision_maker: "Owner" };
/** Telegram user ids of the two members every channel home has. */
export const ADA = { channel: "telegram", address: "1001" };
export const OWNER = { channel: "telegram", address: "1002" };

/** Points this test file's process at the fake Telegram and a private keychain holding the bot token. */
export async function useFakeTelegram(fake: FakeTelegram): Promise<void> {
  const dir = await makeTempHome();
  vi.stubEnv("INSTALLER_CONNECTOR_SERVER", fake.url);
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", dir);
  await setSecret("telegram", BOT_TOKEN, { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir });
}

/**
 * A home pinned to the channels fixture, its Telegram channel verified, Ada (member) and Owner (decision maker)
 * joined. `finished`: the install's one step is done, so real messages are sent; otherwise they are recorded (R6).
 */
export async function channelHome(finished: boolean, at = "2026-10-08T12:00:00.000Z"): Promise<string> {
  const home = await makeTempHome();
  await writePinnedSolution(home, CHANNELS_TEXT);
  const steps: Record<string, StepRecord> = finished ? { "report.final": { status: "done", at } } : {};
  await saveState(home, { schema: 1, solution: { ref: "file:solution-channels.json", id: "fixture-channels", version: "1.0.0" }, started_at: at, steps, roles: ROLES });
  await saveChannel(home, { channel: "telegram", bot: { id: 999, username: "desk_test_bot" }, verified_at: at });
  for (const [name, identity] of [["Ada", ADA], ["Owner", OWNER]] as const) {
    const { code } = await createInvite(home, name, ROLES, at);
    await joinWithCode(home, code, identity, at);
  }
  return home;
}
