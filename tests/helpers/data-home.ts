import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { saveMapping, saveSource } from "../../src/core/data-source.js";
import { setSecret } from "../../src/core/keychain.js";
import { writePinnedSolution } from "../../src/core/pin.js";
import type { FakeGoogle } from "./fake-google.js";
import { SIGNED_IN } from "./fake-google.js";
import { makeTempHome } from "./temp-home.js";

const DATA_TEXT = readFileSync("tests/fixtures/solution-data.json", "utf8");
export const HEADER = ["Full name", "E-mail", "Notes", "Balance", "Owner"];
export const COLUMNS = { name: "Full name", email: "E-mail", notes: "Notes", balance: "Balance" };
const CONNECTOR = { id: "google-sheets", version: "1", sha256: "pinned" };

/** Points this test file's process at the fake Google and a private keychain holding a sign-in. */
export async function useFakeGoogle(fake: FakeGoogle): Promise<void> {
  const dir = await makeTempHome();
  vi.stubEnv("INSTALLER_CONNECTOR_SERVER", fake.url);
  vi.stubEnv("INSTALLER_KEYCHAIN_DIR", dir);
  await setSecret("google", SIGNED_IN, { INSTALLER_KEYCHAIN: "file", INSTALLER_KEYCHAIN_DIR: dir });
}

/** A home pinned to the data fixture, its contact entity connected to a seeded sheet and mapped. */
export async function connectedHome(fake: FakeGoogle, sheetId: string, rows: readonly (readonly string[])[]): Promise<string> {
  const home = await makeTempHome();
  await writePinnedSolution(home, DATA_TEXT);
  await fake.debug(`/debug/sheets/${sheetId}`, { title: sheetId, tabs: { People: [HEADER, ...rows] } });
  await saveSource(home, { entity: "contact", connector: CONNECTOR, spreadsheet_id: sheetId });
  await saveMapping(home, { entity: "contact", columns: COLUMNS });
  return home;
}

export async function sheetRows(fake: FakeGoogle, sheetId: string): Promise<string[][]> {
  return ((await fake.debug(`/debug/sheets/${sheetId}`)) as { tabs: Record<string, string[][]> }).tabs.People ?? [];
}
