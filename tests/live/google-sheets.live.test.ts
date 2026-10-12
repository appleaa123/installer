/**
 * Opt-in live test of the Google Sheets connector (D48, D67): `npm run test:live` with
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (a sign-in with the spreadsheets scope) and
 *   GOOGLE_TEST_SHEET_ID (a spreadsheet kept for testing)
 * in the environment; everything is skipped when any of them is empty. It calls only
 * https://oauth2.googleapis.com/token (the token refresh) and https://sheets.googleapis.com, and only touches the
 * test spreadsheet: it adds a dedicated tab, runs the Sheets adapter's contract there (the same checks the offline
 * suite runs against the fake, D118), and deletes the tab afterwards. It never calls spreadsheets.create (that would
 * make a new file in the account); the offline tests cover it against the fake.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConnector, type ConnectorDef } from "../../src/core/connectors.js";
import { clientOwnedTokens, type AccessTokenSource } from "../../src/core/google-auth.js";
import { sheetsClient, type SheetLocation } from "../../src/core/sheets.js";
import { sheetsContract } from "../helpers/contracts.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN ?? "";
const SHEET_ID = process.env.GOOGLE_TEST_SHEET_ID ?? "";
const SHEETS_API = "https://sheets.googleapis.com/v4";
/** No loopback override, whatever the shell has set: the live test talks to Google itself. */
const NO_OVERRIDE = {};

describe.skipIf(!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !SHEET_ID)("real Google Sheets (D67)", () => {
  const tab = `installer-live-${Date.now()}`;
  const location: SheetLocation = { spreadsheet_id: SHEET_ID, tab };
  let def: ConnectorDef;
  let tokens: AccessTokenSource;
  let tabId: number | null = null;

  /** spreadsheets.batchUpdate on the test spreadsheet only: add or delete the dedicated tab. */
  async function batchUpdate(request: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${SHEETS_API}/spreadsheets/${encodeURIComponent(SHEET_ID)}:batchUpdate`, {
      method: "POST", headers: { authorization: `Bearer ${await tokens.accessToken()}`, "content-type": "application/json" }, body: JSON.stringify({ requests: [request] }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(`batchUpdate answered HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }

  beforeAll(async () => {
    def = await loadConnector("google-sheets", "1");
    tokens = clientOwnedTokens(def.auth, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN }, NO_OVERRIDE);
    const added = await batchUpdate({ addSheet: { properties: { title: tab } } });
    tabId = ((added.replies as { addSheet: { properties: { sheetId: number } } }[])[0]?.addSheet.properties.sheetId) ?? null;
  });

  afterAll(async () => {
    if (tabId !== null) await batchUpdate({ deleteSheet: { sheetId: tabId } });
  });

  it("refreshes an access token with the stored client", async () => {
    await expect(tokens.accessToken()).resolves.toMatch(/^\S{20,}$/);
  });

  sheetsContract(() => ({ client: sheetsClient(def, tokens, NO_OVERRIDE), location }));
});
